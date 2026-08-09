import express from 'express'
import helmet from 'helmet'
import { config } from './config.js'
import { logger } from './obs/logger.js'
import { connectRedis, redis, redisHealthy } from './db/redis.js'
import { requestId, ok, errorHandler, notFound, installBigIntSerialiser } from './http/envelope.js'
import { fxRouter } from './modules/reference/fx.routes.js'
import { sipRouter } from './modules/calculators/sip.routes.js'
import { upstreamCallsToday } from './modules/reference/fx.service.js'

installBigIntSerialiser()

const app = express()

// Exactly one proxy hop — ours. `true` would let a client forge X-Forwarded-For
// and evade every per-IP rate limit (docs/fincalc-2.0/09 §2.1).
app.set('trust proxy', 1)
app.disable('x-powered-by')

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
    },
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    noSniff: true,
  }),
)
app.use(express.json({ limit: config.BODY_LIMIT }))
app.use(requestId)

// ── health ───────────────────────────────────────────────────────────────────
// /health is liveness and touches nothing. /health/ready checks dependencies and
// is what Compose's healthcheck and the Nginx upstream probe use.
app.get('/v1/health', (_req, res) => ok(res, { status: 'ok' }))

app.get('/v1/health/ready', async (_req, res) => {
  const checks = { redis: redisHealthy() }
  const healthy = Object.values(checks).every(Boolean)
  ok(res, { status: healthy ? 'ready' : 'degraded', checks, fxCallsToday: await upstreamCallsToday() }, healthy ? 200 : 503)
})

// ── v1 ───────────────────────────────────────────────────────────────────────
app.use('/v1/reference', fxRouter)
app.use('/v1/calculators', sipRouter)

app.use(notFound)
app.use(errorHandler)

// ── lifecycle ────────────────────────────────────────────────────────────────
const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV },
    `FinCalc API listening on http://127.0.0.1:${config.PORT}/v1`,
  )
})

void connectRedis()

/**
 * Graceful shutdown. Node does not forward signals or reap children on its own,
 * which is why the container runs dumb-init as PID 1 (08 §4). Here we drain
 * in-flight requests, then close dependencies.
 */
let shuttingDown = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutdown.begin')

    server.close(async () => {
      await Promise.allSettled([redis.quit()])
      logger.info('shutdown.complete')
      process.exit(0)
    })

    // Do not hang forever on a stuck connection.
    setTimeout(() => {
      logger.warn('shutdown.forced')
      process.exit(1)
    }, 10_000).unref()
  })
}

export { app }
