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

/** Appended to every JWT_SIGNING_KEYS rejection — the fix, not just the fault. */
const KEY_FORMAT_HELP = `    Expected a JSON object mapping kid -> base64 of a PKCS8 PEM, e.g.
      JWT_SIGNING_KEYS={"k1":"LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t…"}

    Generate one — openssl only, no container or npm needed:
      echo "JWT_SIGNING_KEYS={\\"k1\\":\\"$(openssl genpkey -algorithm ed25519 | base64 -w0)\\"}"

    (Deliberately not a docker/compose command: compose cannot resolve this
    stack's env while JWT_SIGNING_KEYS is the thing being generated.)
    From a checkout, "npm run keygen" does the same and also handles rotation.`

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

  // ── auth ───────────────────────────────────────────────────────────────────
  /**
   * Ed25519 signing keys as {"kid":"<base64 pkcs8 PEM>"}. Two are live at a time:
   * the current one signs, the previous only verifies (docs 10 §3.1).
   * In development a throwaway pair is generated at boot with a loud warning.
   *
   * PARSED AND SHAPE-CHECKED HERE, not at first use. This was `z.string()`, which
   * accepted any non-empty text: a hand-typed value passed validation, the API
   * logged "listening", and then died in JSON.parse — repeatedly, because
   * `restart: unless-stopped` kept bringing it back. The whole point of this file
   * is that a bad value is a readable boot error, so it has to actually look.
   */
  JWT_SIGNING_KEYS: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z
      .string()
      .transform((raw, ctx): Record<string, string> => {
        const reject = (msg: string): never => {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${msg}\n${KEY_FORMAT_HELP}` })
          return z.NEVER as never
        }

        let json: unknown
        try {
          json = JSON.parse(raw)
        } catch {
          return reject('is not valid JSON.')
        }

        if (typeof json !== 'object' || json === null) return reject('must be a JSON object.')
        // An array is the shape the old docs wrongly described. It parses as JSON
        // and then fails deep inside jose, so name it specifically.
        if (Array.isArray(json)) {
          return reject('is a JSON array; it must be an OBJECT keyed by kid.')
        }

        const entries = Object.entries(json as Record<string, unknown>)
        if (entries.length === 0) return reject('is an empty object — no signing key.')

        for (const [kid, value] of entries) {
          if (typeof value !== 'string' || value.length === 0) {
            return reject(`key "${kid}" must be a non-empty base64 string.`)
          }
          // Decode now rather than trusting it: base64 of anything decodes to
          // something, so check it is actually a PKCS8 PEM.
          const pem = Buffer.from(value, 'base64').toString('utf8')
          if (!pem.includes('BEGIN PRIVATE KEY')) {
            return reject(
              `key "${kid}" does not decode to a PKCS8 private key ` +
                '(expected base64 of a "-----BEGIN PRIVATE KEY-----" PEM).',
            )
          }
        }

        return json as Record<string, string>
      })
      .optional(),
  ),
  JWT_CURRENT_KID: z.string().default('k1'),
  JWT_ISSUER: z.string().default('https://fincalc.vamigo.in'),
  JWT_AUDIENCE: z.string().default('fincalc-app'),
  ACCESS_TOKEN_TTL_S: z.coerce.number().int().default(15 * 60),
  REFRESH_TOKEN_TTL_S: z.coerce.number().int().default(30 * 24 * 3600),

  /**
   * HMAC'd into the password before bcrypt. Lives in the environment, never the
   * database, so a stolen backup alone cannot crack the hashes.
   * NEVER rotate: it invalidates every hash (docs 10 §9.3).
   */
  PASSWORD_PEPPER: z.string().min(16).optional(),
  /** hmac_sha256(user_id, …) for audit rows that must survive DPDP erasure. */
  AUDIT_PEPPER: z.string().min(16).optional(),

  /**
   * Measured, not guessed (docs 10 §4): pick the highest cost under ~250 ms on
   * production hardware. bcryptjs is pure JS and ~3× slower than the native
   * binding, so cost 11 here (~155 ms) is comparable work to native cost 12.
   * Login is the endpoint an attacker floods — too slow is a self-inflicted DoS.
   */
  BCRYPT_COST: z.coerce.number().int().min(8).max(15).default(11),

  /**
   * Rate-limit overrides. Production keeps the defaults in
   * http/middleware/auth.ts; a dev or CI environment registering many throwaway
   * accounts from one IP legitimately needs a higher auth bucket. Tunable via
   * env so it never requires a code change or a deploy.
   */
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).max(10000).default(10),
  RATE_LIMIT_WRITE_MAX: z.coerce.number().int().min(1).max(100000).default(120),

  MAX_DEVICES_PER_USER: z.coerce.number().int().default(5),
  FREE_TIER_GOAL_LIMIT: z.coerce.number().int().default(3),

  /** Comma-separated emails granted the admin claim. */
  ADMIN_EMAILS: z.string().default(''),
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

const isProd = parsed.data.NODE_ENV === 'production'

// Secrets that are mandatory in production but may be absent in development.
// Failing here rather than at first use means a misconfigured deploy never
// starts, instead of serving traffic and only breaking at the login endpoint.
if (isProd) {
  const missing = (['JWT_SIGNING_KEYS', 'PASSWORD_PEPPER', 'AUDIT_PEPPER'] as const).filter(
    (k) => !parsed.data[k],
  )
  if (missing.length) {
    console.error(`\nFinCalc API cannot start in production without: ${missing.join(', ')}\n`)
    process.exit(1)
  }
}

export const config = Object.freeze({
  ...parsed.data,
  isProd,
  isTest: parsed.data.NODE_ENV === 'test',
  fxFreshMs: parsed.data.FX_FRESH_MINUTES * 60 * 1000,
  adminEmails: new Set(
    parsed.data.ADMIN_EMAILS.split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  ),
})

export type Config = typeof config
