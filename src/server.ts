import express from 'express'
import helmet from 'helmet'
import { config } from './config.js'
import { logger } from './obs/logger.js'
import { connectRedis, redis, redisHealthy } from './db/redis.js'
import { connectPrisma, prismaHealthy, unsafeSystemClient } from './db/prisma.js'
import { initSigningKeys } from './modules/auth/crypto.js'
import { requestId, ok, errorHandler, notFound, installBigIntSerialiser } from './http/envelope.js'
import { fxRouter } from './modules/reference/fx.routes.js'
import { sipRouter } from './modules/calculators/sip.routes.js'
import { upstreamCallsToday } from './modules/reference/fx.service.js'
import { authRouter, meRouter } from './modules/auth/auth.routes.js'
import { goalsRouter } from './modules/goals/goals.routes.js'
import { syncRouter } from './modules/sync/sync.routes.js'
import { assertRegistryMatchesEnum } from './modules/sync/registry.js'
import { adminRouter } from './modules/admin/admin.routes.js'

installBigIntSerialiser()
// Fail at boot, not at the first delete, if the sync registry and the
// sync_entity_type enum have drifted apart.
assertRegistryMatchesEnum()

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
  const checks = { redis: redisHealthy(), postgres: prismaHealthy() }
  const healthy = Object.values(checks).every(Boolean)
  ok(res, { status: healthy ? 'ready' : 'degraded', checks, fxCallsToday: await upstreamCallsToday() }, healthy ? 200 : 503)
})

// ── v1 ───────────────────────────────────────────────────────────────────────
app.use('/v1/auth', authRouter)
app.use('/v1/me', meRouter)
app.use('/v1/goals', goalsRouter)
app.use('/v1/sync', syncRouter)
app.use('/v1/reference', fxRouter)
app.use('/v1/calculators', sipRouter)

// Server-rendered admin. Mounted OUTSIDE /v1 because it is not part of the
// public API contract and must never appear in the OpenAPI spec.
app.use('/admin', adminRouter)

app.use(notFound)
app.use(errorHandler)

// ── lifecycle ────────────────────────────────────────────────────────────────

/**
 * SIGNING KEYS BEFORE THE PORT OPENS.
 *
 * This was `app.listen(...)` followed by a floating `void initSigningKeys()`,
 * which is wrong in both directions. On a bad key the process logged "FinCalc
 * API listening", bound the port, and only then died — so the logs said the API
 * had started when it had not. On a key that merely loaded slowly, the port was
 * open and accepting requests while `keys` was still empty, and every sign or
 * verify in that window failed for no visible reason.
 *
 * Awaiting is cheap (one Ed25519 import) and makes "listening" mean it.
 *
 * Redis and Postgres stay non-blocking below on purpose: they reconnect on their
 * own and /v1/health/ready reports them honestly, so a slow database delays
 * readiness rather than preventing startup. A missing signing key is not
 * transient and cannot be recovered from at runtime.
 */
try {
  await initSigningKeys()
} catch (err) {
  // console, not logger: this must be readable in `docker compose logs` even if
  // the failure is early enough that structured logging is noise.
  console.error(
    '\nFinCalc API cannot start — JWT_SIGNING_KEYS could not be loaded:\n' +
      `  ${err instanceof Error ? err.message : String(err)}\n\n` +
      '  The value is well-formed but the key itself was rejected.\n' +
      '  Generate a fresh one with: npm run keygen\n',
  )
  process.exit(1)
}

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV },
    `FinCalc API listening on http://127.0.0.1:${config.PORT}/v1`,
  )
})

void connectRedis()
void connectPrisma()

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
      await Promise.allSettled([redis.quit(), unsafeSystemClient.$disconnect()])
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
