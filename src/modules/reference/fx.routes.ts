import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { getRates } from './fx.service.js'
import { ok } from '../../http/envelope.js'
import { CalcError } from '../../errors.js'
import { config } from '../../config.js'

export const fxRouter: Router = Router()

const querySchema = z.object({
  base: z.string().length(3).toUpperCase().default(config.FX_BASE_CURRENCY),
  symbols: z.string().optional(),
})

/**
 * GET /v1/reference/rates?base=INR&symbols=USD,EUR
 *
 * Auth: guest. Cached server-side; a client cannot cause more than one upstream
 * call per freshness window no matter how often it polls (docs/fincalc-2.0/18).
 */
fxRouter.get('/rates', async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query)
  if (!parsed.success) throw new CalcError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))

  const { base, symbols } = parsed.data
  const { payload, freshness, ageSeconds } = await getRates(base)

  let rates = payload.rates
  if (symbols) {
    // Filtering is presentation-only. The upstream call always fetches every pair —
    // caching per symbol-set would multiply the keys and defeat the whole design.
    const wanted = new Set(symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))
    rates = Object.fromEntries(Object.entries(payload.rates).filter(([code]) => wanted.has(code)))
  }

  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')
  res.setHeader('X-FX-Freshness', freshness)
  res.setHeader('X-FX-Age', String(ageSeconds))

  // fetchedAt and freshness are in the BODY, not only headers: the app shows
  // "Rates as of 8:00 AM" so a user always knows what they are looking at.
  ok(res, {
    base: payload.base,
    fetchedAt: payload.fetchedAt,
    ageSeconds,
    freshness,
    source: payload.source,
    rates,
  })
})
