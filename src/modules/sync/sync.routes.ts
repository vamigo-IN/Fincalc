import { Router } from 'express'
import { z } from 'zod'

import { ok } from '../../http/envelope.js'
import { CalcError } from '../../errors.js'
import { authenticate, rateLimit } from '../../http/middleware/auth.js'
import { pull, push } from './sync.service.js'

export const syncRouter: Router = Router()
syncRouter.use(authenticate)

const pullQuery = z.object({
  since: z.string().regex(/^\d+$/).default('0'),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
})

const pushBody = z.object({
  baseRev: z.string().regex(/^\d+$/).optional(),
  changes: z.record(z.array(z.record(z.unknown()))).default({}),
  deletes: z
    .array(
      z.object({
        entityTable: z.string().max(64),
        entityId: z.string().uuid(),
        deletedAt: z.string().datetime({ offset: true }),
      }),
    )
    .default([]),
})

/**
 * GET /v1/sync?since=<rev>
 *
 * `since=0` is a full bootstrap. The response's `serverRev` is the client's next
 * cursor, and the protocol's central guarantee is that everything at or below it
 * has been delivered.
 */
syncRouter.get('/', rateLimit('sync'), async (req, res) => {
  const q = pullQuery.safeParse(req.query)
  if (!q.success) throw new CalcError(q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  ok(res, await pull(req.auth!.sub, BigInt(q.data.since), q.data.limit))
})

/**
 * POST /v1/sync
 *
 * The whole push is one transaction with one revision. `baseRev` is accepted but
 * NOT enforced: a client may push while behind, then pull. Rejecting a stale
 * pusher would force a pull-before-push round trip on every write for no
 * correctness gain — last-write-wins already resolves the ordering.
 */
syncRouter.post('/', rateLimit('sync'), async (req, res) => {
  const b = pushBody.safeParse(req.body)
  if (!b.success) throw new CalcError(b.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`))
  ok(res, await push(req.auth!.sub, b.data.changes, b.data.deletes))
})
