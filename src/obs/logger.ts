/**
 * Structured logging with an explicit redaction allowlist.
 *
 * Redaction is a LIST OF PATHS, not a denylist, per docs/fincalc-2.0/10 §9.4.
 * Money fields are redacted deliberately: a support engineer never needs a
 * user's salary in a log line, and the aggregate of logged amounts across a log
 * file is a shadow copy of the database.
 */
import pino from 'pino'
import { config } from '../config.js'

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'fincalc-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      // credentials & tokens
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-device-id"]',
      '*.password',
      '*.passwordHash',
      '*.refreshToken',
      '*.accessToken',
      '*.token',
      '*.purchaseToken',
      '*.fcmToken',
      '*.apiKey',
      // identity
      '*.email',
      '*.displayName',
      '*.dateOfBirth',
      '*.city',
      // money — see the note above
      '*.amountPaise',
      '*.incomePaise',
      '*.netWorthPaise',
      '*.principalPaise',
      '*.targetPaise',
      '*.contributionPaise',
      '*.lumpsumPaise',
    ],
    censor: '[redacted]',
  },
  ...(config.isProd
    ? {}
    : { transport: { target: 'pino/file', options: { destination: 1 } } }),
})

/**
 * Truncate a client address to its network prefix — IPv4 to /24, IPv6 to /48 —
 * so it is enough to spot a brute-force from a subnet and not enough to track an
 * individual (docs 10 §9.4).
 *
 * Returned WITHOUT a CIDR suffix. The columns are Postgres `INET`, and Prisma's
 * connector parses that as a bare address: passing "172.22.0.0/24" fails with
 * `AddrParseError(Ip)`. Zeroing the trailing octets is the anonymisation; the
 * suffix was only ever cosmetic.
 */
export function ipPrefix(ip: string | undefined): string | undefined {
  if (!ip) return undefined
  const clean = ip.replace(/^::ffff:/, '')
  if (clean.includes(':')) {
    const groups = clean.split(':').filter(Boolean).slice(0, 3)
    if (groups.length < 3) return undefined
    return `${groups.join(':')}::`
  }
  const parts = clean.split('.')
  if (parts.length !== 4) return undefined
  return `${parts[0]}.${parts[1]}.${parts[2]}.0`
}
