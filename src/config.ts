/**
 * Typed, Zod-validated configuration. Fails fast at boot: a missing or malformed
 * value is a startup crash with a readable message, never a `undefined` that
 * surfaces as a 500 three hours later.
 *
 * Ports are chosen to avoid the VPS's already-occupied set:
 *   BLOCKED: 5432, 5433, 3050, 3000, 5050 (postgres/apps), 6379, 5678 (redis/n8n)
 *   OURS:    5442 (postgres), 6389 (redis), 8087 (api)
 */
import { z } from 'zod'

const BLOCKED_PORTS = new Set([5432, 5433, 3050, 3000, 5050, 6379, 5678])

const portGuard = (label: string) =>
  z.coerce
    .number()
    .int()
    .min(1024)
    .max(65535)
    .refine((p) => !BLOCKED_PORTS.has(p), {
      message: `${label}: port is on the VPS blocked list (${[...BLOCKED_PORTS].join(', ')}). Pick another.`,
    })

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: portGuard('PORT').default(8087),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  REDIS_URL: z.string().url().startsWith('redis://'),

  /**
   * Upstream FX provider key. Server-side ONLY — this value must never reach the
   * APK. See docs/fincalc-2.0/18 §10 and 10 §8.
   * Optional so the service boots without it; /v1/reference/rates then serves
   * from cache or Postgres and reports the misconfiguration honestly.
   */
  // `KEY=` in a .env file yields '' , not undefined. An empty value is how
  // people say "not set", so normalise it before validating.
  EXCHANGERATE_API_KEY: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.string().min(8).optional(),
  ),
  FX_BASE_CURRENCY: z.string().length(3).default('INR'),
  FX_FRESH_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),

  REQUEST_TIMEOUT_MS: z.coerce.number().int().default(15_000),
  BODY_LIMIT: z.string().default('256kb'),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n')
  // Deliberately console, not the logger: the logger itself depends on config.
  console.error(`\nFinCalc API cannot start — invalid configuration:\n${issues}\n`)
  process.exit(1)
}

export const config = Object.freeze({
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
  fxFreshMs: parsed.data.FX_FRESH_MINUTES * 60 * 1000,
})

export type Config = typeof config
