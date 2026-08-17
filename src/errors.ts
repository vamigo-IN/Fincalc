/**
 * The error catalogue from docs/fincalc-2.0/07 §12.
 *
 * Codes are APPEND-ONLY. A deployed Android app switches on these strings and
 * will never be updated; renaming one breaks a client permanently.
 */

export const ERROR_CATALOGUE = {
  VALIDATION_FAILED:        { status: 422, message: 'Please check the highlighted fields.' },
  UNAUTHENTICATED:          { status: 401, message: 'Please sign in to continue.' },
  ACCESS_TOKEN_EXPIRED:     { status: 401, message: 'Your session needs refreshing.' },
  REFRESH_TOKEN_INVALID:    { status: 401, message: 'Your session has ended. Please sign in.' },
  REFRESH_TOKEN_EXPIRED:    { status: 401, message: 'Your session has ended. Please sign in.' },
  REFRESH_TOKEN_REVOKED:    { status: 401, message: 'This device was signed out.' },
  REFRESH_TOKEN_REUSED:     { status: 401, message: 'For your security we signed you out of all devices.' },
  FORBIDDEN:                { status: 403, message: 'You do not have access to this.' },
  PREMIUM_REQUIRED:         { status: 403, message: 'This is a FinCalc Pro feature.' },
  EMAIL_ALREADY_REGISTERED: { status: 409, message: 'An account with this email already exists.' },
  EMAIL_NOT_VERIFIED:       { status: 403, message: 'Please verify your email first.' },
  WEAK_PASSWORD:            { status: 422, message: 'Choose a longer password.' },
  ACCOUNT_LOCKED:           { status: 423, message: 'Too many attempts. Try again in a few minutes.' },
  NOT_FOUND:                { status: 404, message: "We couldn't find that." },
  ROW_NOT_OWNED:            { status: 403, message: 'That item belongs to another account.' },
  GOAL_LIMIT_REACHED:       { status: 403, message: 'Free accounts can track up to 3 goals.' },
  GOAL_DATES_INVALID:       { status: 422, message: 'The target date must be after the start date.' },
  BUDGET_ALREADY_EXISTS:    { status: 409, message: 'You already have a budget for this month.' },
  CATEGORY_IN_USE:          { status: 409, message: "This category has transactions and can't be removed." },
  SYNC_CURSOR_TOO_OLD:      { status: 409, message: 'Re-syncing from scratch.' },
  SYNC_TABLE_NOT_WRITABLE:  { status: 422, message: 'That data cannot be synced.' },
  SYNC_PAYLOAD_TOO_LARGE:   { status: 413, message: 'Too much to sync at once — retrying in smaller batches.' },
  CREDIT_HEALTH_INSUFFICIENT_INPUT: { status: 422, message: 'Add a little more to see your credit health.' },
  CALCULATOR_UNKNOWN:       { status: 404, message: "That calculator isn't available." },
  RULESET_NOT_FOUND:        { status: 404, message: "Tax rules for that year aren't available yet." },
  RATES_UNAVAILABLE:        { status: 503, message: 'Exchange rates are temporarily unavailable.' },
  FEED_UNAVAILABLE:         { status: 503, message: 'Live market prices are temporarily unavailable.' },
  IDEMPOTENCY_KEY_REUSED:   { status: 409, message: 'This request was already processed.' },
  RATE_LIMITED:             { status: 429, message: 'Please slow down and try again shortly.' },
  MINIMUM_VERSION_REQUIRED: { status: 426, message: 'Please update FinCalc to continue.' },
  INTERNAL_ERROR:           { status: 500, message: 'Something went wrong. Please try again.' },
  SERVICE_UNAVAILABLE:      { status: 503, message: 'FinCalc is briefly unavailable. Try again shortly.' },
} as const

export type ErrorCode = keyof typeof ERROR_CATALOGUE

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details: unknown[]
  /** Non-user-facing context for the log line only. Never serialised to a client. */
  readonly context?: Record<string, unknown>

  constructor(code: ErrorCode, opts: { details?: unknown[]; context?: Record<string, unknown>; cause?: unknown } = {}) {
    const entry = ERROR_CATALOGUE[code]
    super(entry.message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'AppError'
    this.code = code
    this.status = entry.status
    this.details = opts.details ?? []
    if (opts.context) this.context = opts.context
    Error.captureStackTrace?.(this, AppError)
  }
}

/** A domain-level calculation failure — mirrors CalcFailure in fincalc_core. */
export class CalcError extends AppError {
  constructor(details: string[]) {
    super('VALIDATION_FAILED', { details })
    this.name = 'CalcError'
  }
}
