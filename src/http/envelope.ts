import type { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'node:crypto'
import { AppError, ERROR_CATALOGUE } from '../errors.js'
import { logger, ipPrefix } from '../obs/logger.js'
import { config } from '../config.js'

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string
  }
}

/** Every response carries a request id; every log line can be joined to it. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id')
  req.requestId = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID()
  res.setHeader('X-Request-Id', req.requestId)
  next()
}

/** `{ data, meta }` — docs/fincalc-2.0/07 §1. */
export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({
    data,
    meta: { requestId: res.req.requestId, serverTime: new Date().toISOString() },
  })
}

/**
 * BigInt does not survive JSON.stringify. Money is BIGINT paise everywhere
 * (05 L1), so without this every money-bearing response would throw.
 * Registered ONCE, here, with a comment pointing at 06 §9.1.
 * A `res.json` replacer would miss JSON.stringify calls in logging and job
 * payloads — which is where it would fail at the worst moment.
 */
export function installBigIntSerialiser(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(BigInt.prototype as any).toJSON = function () {
    return this.toString()
  }
}

export function notFound(_req: Request, _res: Response, next: NextFunction): void {
  next(new AppError('NOT_FOUND'))
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const appErr =
    err instanceof AppError
      ? err
      : new AppError('INTERNAL_ERROR', { cause: err })

  const level = appErr.status >= 500 ? 'error' : 'warn'
  logger[level](
    {
      err: config.isProd && appErr.status >= 500 ? undefined : err,
      code: appErr.code,
      status: appErr.status,
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      ip: ipPrefix(req.ip),
      ...appErr.context,
    },
    'request.failed',
  )

  if (appErr.status === 429 || appErr.status === 503) res.setHeader('Retry-After', '30')

  res.status(appErr.status).json({
    error: {
      code: appErr.code,
      message: ERROR_CATALOGUE[appErr.code].message,
      details: appErr.details,
      requestId: req.requestId,
    },
  })
}
