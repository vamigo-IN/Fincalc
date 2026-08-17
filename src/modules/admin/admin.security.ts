/**
 * Admin session, CSRF and brute-force defence.
 *
 * Split out of admin.routes.ts so that every guarantee protecting the account
 * which can read every user's financial data is stated in one file rather than
 * scattered between route handlers.
 *
 * The threat model is not "someone guesses a password on the internet". It is:
 *   - a page on ANOTHER host under vamigo.in submitting a form here,
 *   - an offline guessing run against /admin/login,
 *   - a session that outlives the admin's own access.
 */
import { createHmac, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'

import { config } from '../../config.js'
import { redis, redisHealthy } from '../../db/redis.js'
import { unsafeSystemClient as db } from '../../db/prisma.js'
import { logger, ipPrefix } from '../../obs/logger.js'

const COOKIE = 'fincalc_admin'
const SESSION_TTL_S = 8 * 3600
/** Re-authentication is required after this long regardless of activity. */
const SESSION_ABSOLUTE_TTL_S = 12 * 3600

export interface AdminSession {
  sid: string
  userId: string
  email: string
  /** Epoch seconds. A rolling TTL alone lets one login last indefinitely. */
  createdAt: number
  csrf: string
}

declare module 'express-serve-static-core' {
  interface Request {
    admin?: AdminSession
  }
}

// ── cookie signing ───────────────────────────────────────────────────────────

/**
 * A DEDICATED key, derived from the pepper rather than reusing it.
 *
 * This previously fell back to `config.JWT_CURRENT_KID` when PASSWORD_PEPPER was
 * unset — that is "k1", a public, guessable default. Production requires the
 * pepper so the fallback was unreachable there, but a development box signed
 * admin cookies with a value printed in the compose file.
 *
 * Deriving instead of using the pepper directly means a cookie signature can
 * never be replayed against the password hashes, which use the raw pepper.
 */
/**
 * Unreachable in production — config refuses to boot without the pepper. Random
 * per process in development, so cookies stop working across a restart, which is
 * correct: a box with no pepper should not mint sessions a later process trusts.
 */
const DEV_FALLBACK_KEY = randomBytes(32).toString('base64')

function cookieKey(): string {
  const base = config.PASSWORD_PEPPER
  if (!base) return DEV_FALLBACK_KEY
  return createHmac('sha256', base).update('admin-cookie-v1').digest('base64')
}

function sign(value: string): string {
  return createHmac('sha256', cookieKey()).update(value).digest('base64url')
}

/** Constant-time compare that does not leak length through an early return. */
function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) {
    // Still burn a comparison so a length mismatch is not measurably faster.
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

export function readSessionId(req: Request): string | null {
  const raw = req.header('cookie')
  if (!raw) return null
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k !== COOKIE) continue
    const [sid, sig] = rest.join('=').split('.')
    if (!sid || !sig) return null
    return safeEqualStr(sign(sid), sig) ? sid : null
  }
  return null
}

export function setSessionCookie(res: Response, sid: string): void {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${sid}.${sign(sid)}; HttpOnly; SameSite=Strict; Path=/admin; ` +
      `Max-Age=${SESSION_TTL_S}` + (config.isProd ? '; Secure' : ''),
  )
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`)
}

// ── sessions ─────────────────────────────────────────────────────────────────

const sessKey = (sid: string): string => `admin:sess:${sid}`

export async function createSession(userId: string, email: string): Promise<AdminSession> {
  const session: AdminSession = {
    sid: randomUUID(),
    userId,
    email,
    createdAt: Math.floor(Date.now() / 1000),
    // Per-session CSRF secret. Not derived from the sid: the sid travels in a
    // cookie, and a token an attacker can compute from a value they may observe
    // is not a token.
    csrf: randomBytes(32).toString('base64url'),
  }
  await redis.set(sessKey(session.sid), JSON.stringify(session), 'EX', SESSION_TTL_S)
  return session
}

export async function destroySession(sid: string): Promise<void> {
  if (redisHealthy()) await redis.del(sessKey(sid)).catch(() => null)
}

/** Invalidate every session belonging to a user — used after a password change. */
export async function destroyAllSessionsFor(userId: string): Promise<number> {
  if (!redisHealthy()) return 0
  let cursor = '0'
  let removed = 0
  do {
    // SCAN, not KEYS: KEYS blocks Redis for the whole keyspace, and this runs on
    // the same instance serving rate limits and the FX cache.
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'admin:sess:*', 'COUNT', 200)
    cursor = next
    for (const key of keys) {
      const raw = await redis.get(key).catch(() => null)
      if (!raw) continue
      try {
        if ((JSON.parse(raw) as AdminSession).userId === userId) {
          await redis.del(key)
          removed++
        }
      } catch {
        /* a corrupt session entry is not worth failing a password change over */
      }
    }
  } while (cursor !== '0')
  return removed
}

/**
 * Resolve the current admin, re-checking every condition that granted access.
 *
 * The session used to be trusted for its full 8 hours on the strength of the
 * Redis entry alone. That meant removing someone from ADMIN_EMAILS, suspending
 * their account, or changing the password did not end their session — the very
 * actions taken when an admin should stop having access.
 */
export async function currentAdmin(req: Request): Promise<AdminSession | null> {
  const sid = readSessionId(req)
  // Fail CLOSED when Redis is down: no session store means no way to know a
  // session was revoked, and the admin surface is not worth serving blind.
  if (!sid || !redisHealthy()) return null

  const raw = await redis.get(sessKey(sid)).catch(() => null)
  if (!raw) return null

  let session: AdminSession
  try {
    session = JSON.parse(raw) as AdminSession
  } catch {
    return null
  }

  const ageS = Math.floor(Date.now() / 1000) - session.createdAt
  if (ageS > SESSION_ABSOLUTE_TTL_S) {
    await destroySession(sid)
    return null
  }

  // Still on the allowlist? Removing an email from ADMIN_EMAILS must take
  // effect at the next request, not at the next restart.
  if (!config.adminEmails.has(session.email)) {
    await destroySession(sid)
    logger.warn({ email: session.email }, 'admin.session_revoked_not_allowlisted')
    return null
  }

  // Still an active, undeleted account?
  const user = await db.user.findFirst({
    where: { id: session.userId, deletedAt: null },
    select: { status: true, email: true },
  })
  if (!user || user.status !== 'active' || user.email.toLowerCase() !== session.email) {
    await destroySession(sid)
    return null
  }

  return session
}

// ── CSRF ─────────────────────────────────────────────────────────────────────

/**
 * SameSite=Strict is NOT sufficient here, which is the trap.
 *
 * SameSite is scoped to the registrable domain, so www.vamigo.in and
 * fincalc.vamigo.in are the SAME site. A form on the main Next.js app — or an
 * XSS anywhere under vamigo.in — can POST to /admin/* and the browser attaches
 * the admin cookie. Every state-changing route was open to that: grant an
 * entitlement, toggle a flag, and now change a password.
 *
 * The token is per session and compared in constant time.
 */
export function csrfField(session: AdminSession): string {
  return `<input type="hidden" name="_csrf" value="${session.csrf}">`
}

export const requireCsrf = (req: Request, res: Response, next: NextFunction): void => {
  if (req.method !== 'POST') return next()
  const session = req.admin
  const supplied = String((req.body as Record<string, unknown> | undefined)?._csrf ?? '')

  if (!session || !supplied || !safeEqualStr(session.csrf, supplied)) {
    logger.warn(
      { path: req.path, ip: ipPrefix(req.ip), hasToken: Boolean(supplied) },
      'admin.csrf_rejected',
    )
    res.status(403).type('text/plain').send('CSRF check failed. Reload the page and try again.')
    return
  }
  next()
}

// ── login throttling ─────────────────────────────────────────────────────────

/** Per-IP ceiling on login attempts, independent of which account is targeted. */
const LOGIN_MAX_PER_IP = 10
const LOGIN_WINDOW_S = 15 * 60

/**
 * There was NO limit of any kind on /admin/login.
 *
 * The mobile login path locks an account after 5 failures (auth.service.ts), but
 * the admin form read the same user row and never touched failedLoginCount — so
 * the one account that can read every user's finances was the one account with
 * unlimited guesses, and the lockout on its own row was bypassed.
 *
 * Two independent limits, because each covers the other's gap: the per-IP
 * counter stops one host spraying many accounts, and the per-account lockout
 * stops a distributed run against a single known admin email.
 */
export async function loginAttemptsExceeded(req: Request): Promise<boolean> {
  if (!redisHealthy()) return false // availability over fairness, as elsewhere
  const subject = ipPrefix(req.ip) ?? 'unknown'
  const window = Math.floor(Date.now() / 1000 / LOGIN_WINDOW_S)
  const key = `admin:login:${subject}:${window}`
  try {
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, LOGIN_WINDOW_S)
    return count > LOGIN_MAX_PER_IP
  } catch {
    return false
  }
}

export const LOCKOUT_THRESHOLD = 5

/** Matches auth.service.ts: escalating, capped at 15 minutes. */
export function lockoutUntil(failedCount: number): Date | null {
  if (failedCount < LOCKOUT_THRESHOLD) return null
  return new Date(Date.now() + Math.min(failedCount - (LOCKOUT_THRESHOLD - 1), 15) * 60_000)
}

// ── response hardening ───────────────────────────────────────────────────────

/**
 * Admin pages render other people's financial data. Without this a shared proxy
 * or the browser's back-forward cache can retain a page after sign-out.
 */
export const noStore = (_req: Request, res: Response, next: NextFunction): void => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Referrer-Policy', 'no-referrer')
  next()
}

export { COOKIE, SESSION_TTL_S, SESSION_ABSOLUTE_TTL_S, LOGIN_MAX_PER_IP, LOGIN_WINDOW_S }
