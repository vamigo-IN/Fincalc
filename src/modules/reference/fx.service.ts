/**
 * Currency rates — docs/fincalc-2.0/18.
 *
 * One upstream call per hour AT MOST, made lazily and only when a user asks.
 * The three controls that make that guarantee hold:
 *
 *   §3.1 single-flight lock  — the expiry stampede fires ONE upstream call
 *   §3.2 stale-while-revalidate — nobody waits for a refresh; TTL is 25h, not 1h,
 *        because freshness is a timestamp comparison and not an eviction
 *   §3.3 failure cooldown    — an upstream outage cannot turn a lazy fetcher into
 *        hundreds of retries per hour. This is the control the original spec
 *        lacked, and the one that actually bounds the budget.
 */
import { randomUUID } from 'node:crypto'
import { config } from '../../config.js'
import { redis, redisHealthy, releaseLock } from '../../db/redis.js'
import { logger } from '../../obs/logger.js'
import { AppError } from '../../errors.js'

const REDIS_TTL_S = 25 * 60 * 60 // stale ceiling, NOT the freshness window
const LOCK_MS = 30_000
const COOLDOWN_MS = 5 * 60 * 1000
const WAIT_TOTAL_MS = 2_000
const WAIT_STEP_MS = 50
const UPSTREAM_TIMEOUT_MS = 8_000

export type Freshness = 'fresh' | 'stale' | 'cold'

export interface RatePayload {
  base: string
  fetchedAt: string
  source: string
  rates: Record<string, number>
}

export interface RateResponse {
  payload: RatePayload
  freshness: Freshness
  ageSeconds: number
}

const key = {
  rates: (b: string) => `fx:rates:v1:${b}`,
  lock: (b: string) => `fx:lock:${b}`,
  cooldown: (b: string) => `fx:cooldown:${b}`,
  calls: (d: string) => `fx:stats:calls:${d}`,
}

const ageMs = (p: RatePayload) => Date.now() - Date.parse(p.fetchedAt)
const today = () => new Date().toISOString().slice(0, 10)

/** Optional durable fallback. Injected so the service works with or without a DB. */
export interface RateStore {
  persist(payload: RatePayload): Promise<void>
  readLatest(base: string): Promise<RatePayload | null>
}

let store: RateStore | null = null
export function setRateStore(s: RateStore | null): void {
  store = s
}

// ─────────────────────────────────────────────────────────────────────────────

export async function getRates(base = config.FX_BASE_CURRENCY): Promise<RateResponse> {
  const cached = await readCache(base)

  // 1. Fresh — the overwhelmingly common path. One Redis GET, no lock, no upstream.
  if (cached && ageMs(cached) < config.fxFreshMs) {
    return { payload: cached, freshness: 'fresh', ageSeconds: Math.floor(ageMs(cached) / 1000) }
  }

  // 2. Stale — serve NOW, refresh behind the response if we win the lock.
  if (cached) {
    void refreshIfLeader(base).catch((err) => logger.warn({ err, base }, 'fx.background_refresh_failed'))
    return { payload: cached, freshness: 'stale', ageSeconds: Math.floor(ageMs(cached) / 1000) }
  }

  // 3. Cold — someone must fetch synchronously.
  const token = randomUUID()
  if (await acquire(base, token)) {
    try {
      const fresh = await fetchAndStore(base)
      return { payload: fresh, freshness: 'cold', ageSeconds: Math.floor(ageMs(fresh) / 1000) }
    } finally {
      await releaseLock(key.lock(base), token)
    }
  }

  // 3b. Lock lost on a cold cache — wait for the winner rather than duplicating the call.
  const arrived = await waitForCache(base)
  if (arrived) {
    return { payload: arrived, freshness: 'cold', ageSeconds: Math.floor(ageMs(arrived) / 1000) }
  }

  // 4. Last resort: durable history (§7). Survives a Redis flush or eviction.
  const fromDb = await store?.readLatest(base).catch(() => null)
  if (fromDb) {
    await writeCache(base, fromDb)
    return { payload: fromDb, freshness: 'cold', ageSeconds: Math.floor(ageMs(fromDb) / 1000) }
  }

  throw new AppError('RATES_UNAVAILABLE', { context: { base, reason: 'no cache, no store, no upstream' } })
}

/** Only the lock winner refreshes; losers return immediately. Nobody is waiting. */
async function refreshIfLeader(base: string): Promise<void> {
  const token = randomUUID()
  if (!(await acquire(base, token))) return
  try {
    await fetchAndStore(base)
  } finally {
    await releaseLock(key.lock(base), token)
  }
}

async function fetchAndStore(base: string): Promise<RatePayload> {
  // The cooldown is checked HERE, inside the lock, so every path that could
  // reach the upstream honours it (§3.3).
  if (await inCooldown(base)) {
    const fallback = (await readCache(base)) ?? (await store?.readLatest(base).catch(() => null))
    if (fallback) return fallback
    throw new AppError('RATES_UNAVAILABLE', { context: { base, reason: 'cooldown, no fallback' } })
  }

  if (!config.EXCHANGERATE_API_KEY) {
    // Misconfiguration, reported honestly rather than as a mysterious 503.
    logger.error('fx.no_api_key — set EXCHANGERATE_API_KEY (server-side only, never in the APK)')
    await setCooldown(base)
    const fallback = (await readCache(base)) ?? (await store?.readLatest(base).catch(() => null))
    if (fallback) return fallback
    throw new AppError('RATES_UNAVAILABLE', { context: { base, reason: 'EXCHANGERATE_API_KEY unset' } })
  }

  const url = `https://v6.exchangerate-api.com/v6/${config.EXCHANGERATE_API_KEY}/latest/${base}`

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
    await countCall()

    if (!res.ok) throw new Error(`upstream HTTP ${res.status}`)
    const body = (await res.json()) as { result?: string; conversion_rates?: Record<string, number> }
    if (body.result !== 'success' || !body.conversion_rates) throw new Error('upstream payload malformed')

    const payload: RatePayload = {
      base,
      fetchedAt: new Date().toISOString(),
      source: 'exchangerate-api',
      rates: body.conversion_rates,
    }

    await writeCache(base, payload)
    await store?.persist(payload).catch((err) => logger.warn({ err }, 'fx.persist_failed'))
    logger.info({ base, pairs: Object.keys(payload.rates).length }, 'fx.refreshed')
    return payload
  } catch (err) {
    // Back off BEFORE anyone can try again — this is what bounds the budget.
    await setCooldown(base)
    logger.error({ err, base }, 'fx.upstream_failed')

    const fallback = (await readCache(base)) ?? (await store?.readLatest(base).catch(() => null))
    if (fallback) return fallback // stale beats nothing
    throw new AppError('RATES_UNAVAILABLE', { cause: err, context: { base } })
  }
}

// ── Redis primitives ─────────────────────────────────────────────────────────

async function readCache(base: string): Promise<RatePayload | null> {
  if (!redisHealthy()) return null
  try {
    const raw = await redis.get(key.rates(base))
    return raw ? (JSON.parse(raw) as RatePayload) : null
  } catch {
    return null
  }
}

async function writeCache(base: string, p: RatePayload): Promise<void> {
  if (!redisHealthy()) return
  try {
    await redis.set(key.rates(base), JSON.stringify(p), 'EX', REDIS_TTL_S)
  } catch (err) {
    logger.warn({ err }, 'fx.cache_write_failed')
  }
}

async function acquire(base: string, token: string): Promise<boolean> {
  if (!redisHealthy()) return true // no Redis ⇒ no coordination possible; proceed
  try {
    const r = await redis.set(key.lock(base), token, 'PX', LOCK_MS, 'NX')
    return r === 'OK'
  } catch {
    return true
  }
}

async function waitForCache(base: string): Promise<RatePayload | null> {
  const deadline = Date.now() + WAIT_TOTAL_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, WAIT_STEP_MS))
    const p = await readCache(base)
    if (p) return p
  }
  return null
}

async function inCooldown(base: string): Promise<boolean> {
  if (!redisHealthy()) return false
  try {
    return (await redis.exists(key.cooldown(base))) === 1
  } catch {
    return false
  }
}

async function setCooldown(base: string): Promise<void> {
  if (!redisHealthy()) return
  try {
    await redis.set(key.cooldown(base), '1', 'PX', COOLDOWN_MS)
  } catch {
    /* best effort */
  }
}

/** Daily upstream call counter — the budget alert in 18 §11 reads this. */
async function countCall(): Promise<void> {
  if (!redisHealthy()) return
  try {
    const k = key.calls(today())
    const n = await redis.incr(k)
    await redis.expire(k, 48 * 3600)
    if (n > 30) logger.warn({ calls: n }, 'fx.budget_exceeded — more than 30 upstream calls today')
  } catch {
    /* best effort */
  }
}

/** Exposed for the health endpoint and tests. */
export async function upstreamCallsToday(): Promise<number> {
  if (!redisHealthy()) return -1
  try {
    return Number((await redis.get(key.calls(today()))) ?? 0)
  } catch {
    return -1
  }
}
