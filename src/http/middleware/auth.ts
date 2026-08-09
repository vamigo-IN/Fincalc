import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { verifyAccessToken, type AccessClaims } from '../../modules/auth/crypto.js'
import { AppError } from '../../errors.js'
import { redis, redisHealthy } from '../../db/redis.js'
import { unsafeSystemClient as db } from '../../db/prisma.js'
import { ipPrefix } from '../../obs/logger.js'
import { config } from '../../config.js'

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AccessClaims & { jti: string }
  }
}

/** Everything the services need about the caller, assembled once per request. */
export function requestCtx(req: Request) {
  return {
    ipPrefix: ipPrefix(req.ip),
    userAgent: req.header('user-agent')?.slice(0, 400),
    deviceId: req.header('x-device-id'),
    platform: (req.header('x-platform') as 'android' | 'ios' | 'web' | undefined) ?? undefined,
  }
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.header('authorization')
  if (!header?.startsWith('Bearer ')) return next(new AppError('UNAUTHENTICATED'))

  const claims = await verifyAccessToken(header.slice(7))

  // The one lever that makes a 15-minute access token revocable early:
  // logout-all and admin lockout write a deny marker (docs 10 §3.4).
  if (redisHealthy()) {
    const denied = await redis.get(`sess:deny:${claims.sid}`).catch(() => null)
    if (denied) return next(new AppError('REFRESH_TOKEN_REVOKED'))
  }

  req.auth = claims
  next()
}

/** Routes that work for guests but personalise when a token is present. */
export const optionalAuth: RequestHandler = async (req, _res, next) => {
  const header = req.header('authorization')
  if (!header?.startsWith('Bearer ')) return next()
  try {
    req.auth = await verifyAccessToken(header.slice(7))
  } catch {
    /* an invalid token on a guest route is simply ignored */
  }
  next()
}

/**
 * Premium is checked against `entitlements` on EVERY call, never against the
 * token's `ent` claim. That claim is a UI cache with a 15-minute staleness
 * window — fine for showing a button, never for authorising the action behind it.
 */
export const requirePremium =
  (featureKey: string): RequestHandler =>
  async (req, _res, next) => {
    if (!req.auth) return next(new AppError('UNAUTHENTICATED'))
    const live = await db.entitlement.findFirst({
      where: {
        userId: req.auth.sub,
        featureKey,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true },
    })
    if (!live) return next(new AppError('PREMIUM_REQUIRED', { context: { featureKey } }))
    next()
  }

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(new AppError('UNAUTHENTICATED'))
  if (!req.auth.adm) return next(new AppError('FORBIDDEN'))
  next()
}

// ── rate limiting ────────────────────────────────────────────────────────────

export type Bucket = 'auth' | 'refresh' | 'read' | 'write' | 'compute' | 'sync' | 'report'

/** docs/fincalc-2.0/07 §1. Per user where we know them, per IP otherwise. */
const LIMITS: Record<Bucket, { max: number; windowS: number }> = {
  auth: { max: 10, windowS: 15 * 60 },
  refresh: { max: 60, windowS: 3600 },
  read: { max: 300, windowS: 60 },
  write: { max: 120, windowS: 60 },
  compute: { max: 60, windowS: 60 },
  sync: { max: 30, windowS: 60 },
  report: { max: 10, windowS: 3600 },
}

/**
 * Fixed-window counter in Redis. Not a true sliding window — at the boundary a
 * client can burst up to 2× the limit. That is acceptable here because Nginx
 * already sheds volumetric floods (docs 09 §2.1) and this layer exists for
 * per-user fairness, not DDoS defence. A sorted-set sliding window would cost a
 * ZREMRANGEBYSCORE + ZADD + ZCARD per request for a bound nobody is relying on.
 */
export const rateLimit =
  (bucket: Bucket): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction) => {
    if (!redisHealthy()) return next() // fail open: availability over fairness

    const { max, windowS } = LIMITS[bucket]
    const subject = req.auth?.sub ?? ipPrefix(req.ip) ?? 'unknown'
    const window = Math.floor(Date.now() / 1000 / windowS)
    const key = `rl:${bucket}:${subject}:${window}`

    try {
      const count = await redis.incr(key)
      if (count === 1) await redis.expire(key, windowS)
      res.setHeader('X-RateLimit-Limit', String(max))
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)))
      if (count > max) {
        res.setHeader('Retry-After', String(windowS))
        return next(new AppError('RATE_LIMITED', { context: { bucket, subject } }))
      }
    } catch {
      /* Redis hiccup must not take the API down */
    }
    next()
  }

export const MAX_DEVICES = config.MAX_DEVICES_PER_USER
