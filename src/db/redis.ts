// Named import, not default: under NodeNext ESM the CJS default is not constructable.
import { Redis } from 'ioredis'
import { config } from '../config.js'
import { logger } from '../obs/logger.js'

/**
 * Redis holds only ephemeral, reconstructible state — caches, rate-limit
 * counters, idempotency records, locks. Nothing here is a source of truth, which
 * is why docs/fincalc-2.0/08 §7 deliberately does not back it up.
 */
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
  lazyConnect: true,
  retryStrategy: (times: number) => Math.min(times * 200, 3_000),
})

redis.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis.error'))
redis.on('ready', () => logger.info('redis.ready'))

let connected = false

export async function connectRedis(): Promise<void> {
  try {
    await redis.connect()
    connected = true
  } catch (err) {
    // Not fatal: the API still serves calculators, which need nothing but CPU.
    logger.error({ err }, 'redis.connect_failed — degraded mode')
  }
}

export function redisHealthy(): boolean {
  return connected && redis.status === 'ready'
}

/**
 * Release a lock only if we still hold it. Without the compare, a fetch that
 * overruns its lock TTL deletes a lock a *different* request has since acquired,
 * and two upstream calls run concurrently — precisely what the lock prevents.
 */
const RELEASE_IF_MINE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`

export async function releaseLock(key: string, token: string): Promise<void> {
  try {
    await redis.eval(RELEASE_IF_MINE, 1, key, token)
  } catch (err) {
    logger.warn({ err, key }, 'redis.release_lock_failed')
  }
}
