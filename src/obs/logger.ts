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

/** IPv4 → /24, IPv6 → /48. Never store a full client address (10 §9.4). */
export function ipPrefix(ip: string | undefined): string | undefined {
  if (!ip) return undefined
  const clean = ip.replace(/^::ffff:/, '')
  if (clean.includes(':')) return clean.split(':').slice(0, 3).join(':') + '::/48'
  const parts = clean.split('.')
  if (parts.length !== 4) return undefined
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`
}
