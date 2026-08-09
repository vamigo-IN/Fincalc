import { Router, type Request } from 'express'
import { z } from 'zod'
import { uuidv7 } from 'uuidv7'
import { ok } from '../../http/envelope.js'
import { AppError, CalcError } from '../../errors.js'
import { authenticate, rateLimit } from '../../http/middleware/auth.js'
import { forUser, unsafeSystemClient as db } from '../../db/prisma.js'
import { config } from '../../config.js'
import { wireToPaise } from '../../engines/money.js'
import { project, type SipPlan } from '../../engines/sip.js'

export const goalsRouter: Router = Router()
goalsRouter.use(authenticate)

const paiseInput = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
const paise = paiseInput.transform(wireToPaise)
/**
 * `.default()` wraps the OUTER schema, so the default value is fed through the
 * union BEFORE the transform runs. Defaulting to `0n` therefore fails validation
 * with "Invalid input" — the default has to be in wire shape, i.e. the string '0'.
 */
const paiseOr0 = paiseInput.default('0').transform(wireToPaise)
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const GOAL_TYPES = [
  'retirement', 'education', 'home', 'vehicle', 'travel', 'wedding',
  'emergency', 'debt_payoff', 'wealth', 'custom',
] as const

const createSchema = z.object({
  // Client-supplied UUIDv7 (docs 05 L3). A server-minted id for an offline-created
  // row comes back on the next pull as a DUPLICATE of the local one.
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  goalType: z.enum(GOAL_TYPES).default('custom'),
  targetAmountPaise: paise,
  startDate: isoDate,
  targetDate: isoDate,
  priority: z.number().int().min(1).max(1000).default(100),
  expectedReturnRateMicro: z.number().int().min(-500_000).max(1_000_000).default(120_000),
  monthlyContributionPaise: paiseOr0,
  notes: z.string().max(2000).optional(),
  sourceCalculationId: z.string().uuid().optional(),
})

const patchSchema = createSchema.partial().omit({ id: true })

/**
 * Express 5 types a path param as `string | string[] | undefined`. Narrowing it
 * here also validates the shape, so a malformed id is a clean 404 rather than a
 * Prisma error leaking through.
 */
function pathId(req: Request, name = 'id'): string {
  const v = req.params[name]
  if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    throw new AppError('NOT_FOUND')
  }
  return v
}

const parse = <T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> => {
  const r = schema.safeParse(body)
  if (!r.success) throw new CalcError(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`))
  return r.data
}

/** Serialise for the wire: BigInt → string is handled globally, dates → ISO date. */
function toWire(g: Record<string, unknown>) {
  return {
    ...g,
    startDate: (g.startDate as Date).toISOString().slice(0, 10),
    targetDate: (g.targetDate as Date).toISOString().slice(0, 10),
  }
}

// ── list ─────────────────────────────────────────────────────────────────────

goalsRouter.get('/', rateLimit('read'), async (req, res) => {
  const gdb = forUser(req.auth!.sub)
  const goals = await gdb.goal.findMany({
    where: { deletedAt: null },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    take: 100,
  })
  ok(res, { goals: goals.map((g) => toWire(g as unknown as Record<string, unknown>)) })
})

// ── create ───────────────────────────────────────────────────────────────────

goalsRouter.post('/', rateLimit('write'), async (req, res) => {
  const body = parse(createSchema, req.body)
  const userId = req.auth!.sub
  const gdb = forUser(userId)

  if (new Date(body.targetDate) <= new Date(body.startDate)) {
    throw new AppError('GOAL_DATES_INVALID')
  }

  // Free-tier cap. Enforced server-side; the client's copy is a hint only.
  const isPremium = await db.entitlement.findFirst({
    where: {
      userId, featureKey: 'unlimited_goals', revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true },
  })
  if (!isPremium) {
    const active = await gdb.goal.count({ where: { status: 'active', deletedAt: null } })
    if (active >= config.FREE_TIER_GOAL_LIMIT) {
      throw new AppError('GOAL_LIMIT_REACHED', { context: { active, limit: config.FREE_TIER_GOAL_LIMIT } })
    }
  }

  const created = await db.$transaction(async (tx) => {
    const rev = await nextSyncRev(tx, userId)
    return tx.goal.create({
      data: {
        id: body.id,
        userId,
        name: body.name,
        goalType: body.goalType,
        targetAmountPaise: body.targetAmountPaise,
        startDate: new Date(body.startDate),
        targetDate: new Date(body.targetDate),
        priority: body.priority,
        expectedReturnRateMicro: body.expectedReturnRateMicro,
        monthlyContributionPaise: body.monthlyContributionPaise,
        notes: body.notes ?? null,
        sourceCalculationId: body.sourceCalculationId ?? null,
        syncRev: rev,
      },
    })
  })

  ok(res, toWire(created as unknown as Record<string, unknown>), 201)
})

// ── read / update / delete ───────────────────────────────────────────────────

goalsRouter.get('/:id', rateLimit('read'), async (req, res) => {
  const id = pathId(req)
  const gdb = forUser(req.auth!.sub)
  // findFirst, never findUnique — the tenancy extension cannot scope a unique
  // where-clause and throws if you try (docs 05 §8).
  const goal = await gdb.goal.findFirst({ where: { id: id, deletedAt: null } })
  if (!goal) throw new AppError('NOT_FOUND')
  ok(res, toWire(goal as unknown as Record<string, unknown>))
})

goalsRouter.patch('/:id', rateLimit('write'), async (req, res) => {
  const id = pathId(req)
  const body = parse(patchSchema, req.body)
  const userId = req.auth!.sub
  const gdb = forUser(userId)

  const existing = await gdb.goal.findFirst({ where: { id: id, deletedAt: null }, select: { id: true } })
  if (!existing) throw new AppError('NOT_FOUND')

  const data: Record<string, unknown> = {}
  for (const k of ['name', 'goalType', 'targetAmountPaise', 'priority', 'expectedReturnRateMicro', 'monthlyContributionPaise', 'notes'] as const) {
    if (body[k] !== undefined) data[k] = body[k]
  }
  if (body.startDate) data.startDate = new Date(body.startDate)
  if (body.targetDate) data.targetDate = new Date(body.targetDate)

  const updated = await db.$transaction(async (tx) => {
    data.syncRev = await nextSyncRev(tx, userId)
    data.updatedAt = new Date()
    await tx.goal.updateMany({ where: { id: id, userId }, data })
    return tx.goal.findFirst({ where: { id: id, userId } })
  })

  ok(res, toWire(updated as unknown as Record<string, unknown>))
})

goalsRouter.delete('/:id', rateLimit('write'), async (req, res) => {
  const id = pathId(req)
  const userId = req.auth!.sub
  const gdb = forUser(userId)
  const existing = await gdb.goal.findFirst({ where: { id: id, deletedAt: null }, select: { id: true } })
  if (!existing) throw new AppError('NOT_FOUND')

  // SOFT delete + tombstone, in one transaction. A hard delete is invisible to an
  // offline device, which would then resurrect the row on its next push.
  await db.$transaction(async (tx) => {
    const rev = await nextSyncRev(tx, userId)
    const now = new Date()
    await tx.goal.updateMany({ where: { id: id, userId }, data: { deletedAt: now, syncRev: rev } })
    await tx.syncTombstone.upsert({
      where: { userId_entityTable_entityId: { userId, entityTable: 'goals', entityId: id } },
      update: { syncRev: rev, deletedAt: now },
      create: { id: uuidv7(), userId, entityTable: 'goals', entityId: id, syncRev: rev, deletedAt: now },
    })
  })

  ok(res, { deleted: true })
})

// ── projection ───────────────────────────────────────────────────────────────

goalsRouter.get('/:id/projection', rateLimit('compute'), async (req, res) => {
  const id = pathId(req)
  const gdb = forUser(req.auth!.sub)
  const goal = await gdb.goal.findFirst({ where: { id: id, deletedAt: null } })
  if (!goal) throw new AppError('NOT_FOUND')

  const months = Math.max(
    1,
    Math.round((goal.targetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.4375)),
  )
  const plan: SipPlan = {
    contributionPaise: goal.monthlyContributionPaise,
    lumpsumPaise: goal.currentAmountPaise,
    frequency: 'monthly',
    timing: 'due',
    escalation: { type: 'none' },
    years: months / 12,
    expectedReturnMicro: goal.expectedReturnRateMicro,
  }

  const projection = project(plan)
  const shortfall = goal.targetAmountPaise - projection.maturityPaise

  ok(res, {
    goalId: goal.id,
    monthsRemaining: months,
    projectedPaise: projection.maturityPaise,
    targetPaise: goal.targetAmountPaise,
    shortfallPaise: shortfall > 0n ? shortfall : 0n,
    onTrack: shortfall <= 0n,
    fundingRatio:
      goal.targetAmountPaise === 0n ? 1 : Number(projection.maturityPaise) / Number(goal.targetAmountPaise),
    disclaimer:
      'An educational estimate based on the figures you entered and an assumed constant return. Not investment advice.',
  })
})

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allocate this user's next revision INSIDE the writing transaction (docs 05 §7).
 * The row lock serialises allocation and — the property that matters — makes it
 * impossible for a higher rev to become visible before a lower one, which is the
 * silent data-loss bug a plain sequence would introduce.
 */
async function nextSyncRev(tx: { $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }, userId: string): Promise<bigint> {
  const rows = (await tx.$queryRaw`SELECT next_sync_rev(${userId}::uuid) AS rev`) as Array<{ rev: bigint }>
  return rows[0]?.rev ?? 0n
}
