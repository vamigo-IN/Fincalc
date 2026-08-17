/**
 * Live market feed handshake.
 *
 * The prices themselves never pass through this server — the app opens a
 * Socket.IO connection straight to the StockVirtue backend's `/fincalc`
 * namespace. All this endpoint does is hand out a short-lived signed token, and
 * tell the app where to point and what to subscribe to.
 *
 * Keeping the URL and the symbol list in the RESPONSE rather than compiled into
 * the app means the ticker's contents, and the feed's address, can change
 * without a Play Store release.
 */
import { Router, type Request, type Response } from 'express'

import { config } from '../../config.js'
import { ok } from '../../http/envelope.js'
import { AppError } from '../../errors.js'
import { rateLimit } from '../../http/middleware/auth.js'
import { logger } from '../../obs/logger.js'
import { mintFeedToken } from './feed-token.js'

export const marketRouter: Router = Router()

/**
 * GET /v1/market/feed
 *
 * Auth: GUEST, deliberately.
 *
 * The market strip renders on Home for signed-out users, who are most of a
 * calculator app's traffic — the same reasoning that makes /reference/rates
 * public. Requiring a session would blank the ticker for the majority.
 *
 * What that costs, stated plainly: anyone can obtain a 15-minute feed token.
 * What it does NOT cost is the secret, which is the whole point of signing —
 * the long-lived credential stays here instead of inside an APK anyone can
 * unpack, tokens expire on their own, and rotating FEED_TOKEN_SECRET invalidates
 * every outstanding one without an app release. Abuse is bounded at both ends:
 * the `feed` bucket here, and the feed server's own 20-connections-per-IP cap.
 */
marketRouter.get('/feed', rateLimit('feed'), async (_req: Request, res: Response) => {
  if (!config.FEED_TOKEN_SECRET) {
    // A missing secret is a deployment that has not been finished, not a
    // transient fault. Logged loudly here; the client sees a 503 and keeps its
    // existing FX strip rather than an empty screen.
    logger.error(
      'feed.not_configured — set FEED_TOKEN_SECRET to enable the live market feed',
    )
    throw new AppError('FEED_UNAVAILABLE', { context: { reason: 'FEED_TOKEN_SECRET unset' } })
  }

  const { token, expiresAt } = mintFeedToken(
    config.FEED_CLIENT_ID,
    config.FEED_TOKEN_SECRET,
    config.FEED_TOKEN_TTL_S,
  )

  // Never cached. A shared cache holding a credential would hand one client's
  // token to another, and hand out expired ones after the TTL.
  res.setHeader('Cache-Control', 'no-store')

  ok(res, {
    url: config.FEED_BASE_URL,
    namespace: '/fincalc',
    token,
    // Absolute, not a duration: a device with a skewed clock still gets the
    // right answer from the server's own `expiresIn`, and both are provided so
    // the client can pick whichever it trusts.
    expiresAt,
    expiresInSeconds: config.FEED_TOKEN_TTL_S,
    // Empty array means "everything the feed carries" — the app omits the
    // `symbols` handshake field entirely in that case.
    symbols: config.feedSymbols,
  })
})
