/**
 * The sync manifest — docs/fincalc-2.0/02 §4, 05 §7.
 *
 * One entry per pushable entity. Adding a syncable table is a registry entry
 * plus an enum value, not a new code path: every entity goes through the same
 * pull query, the same last-write-wins guard and the same tombstone handling.
 * Divergent per-entity sync code is how one table quietly stops syncing.
 *
 * The keys here MUST match the `sync_entity_type` Postgres enum exactly. A
 * mismatch in either direction fails silently — a table in the enum but not the
 * registry can never be pushed; one in the registry but not the enum cannot have
 * a tombstone written. `assertRegistryMatchesEnum()` makes that a startup error.
 */
import { z } from 'zod'

/** Wire money: a string of integer paise (07 §2). */
const paise = z
  .union([z.string().regex(/^-?\d+$/), z.number().int()])
  .transform((v) => (typeof v === 'bigint' ? v : BigInt(v)))

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const isoTimestamp = z.string().datetime({ offset: true })

/** Every syncable row carries these. `updatedAt` is the LWW comparison key. */
const syncEnvelope = {
  id: z.string().uuid(),
  updatedAt: isoTimestamp,
  deletedAt: isoTimestamp.nullable().optional(),
}

export interface SyncEntity {
  /** The `sync_entity_type` value and the wire key. */
  readonly table: string
  /** The Prisma model delegate name. */
  readonly model: string
  /** Validates one pushed row. */
  readonly schema: z.ZodTypeAny
  /**
   * Columns forming the identity used for upsert. Everything is `id` except
   * `transactions`, whose primary key becomes `(occurred_on, id)` when the table
   * is partitioned — so the payload carries `occurredOn` from v1, before
   * partitioning happens, rather than making it a breaking change later
   * (05 R3).
   */
  readonly identity: readonly string[]
  /** Pull-only entities reject any push (e.g. system-seeded rows). */
  readonly pullOnly?: boolean
}

const goal = z.object({
  ...syncEnvelope,
  name: z.string().min(1).max(120),
  goalType: z.enum([
    'retirement', 'education', 'home', 'vehicle', 'travel', 'wedding',
    'emergency', 'debt_payoff', 'wealth', 'custom',
  ]),
  targetAmountPaise: paise,
  currentAmountPaise: paise.optional(),
  startDate: isoDate,
  targetDate: isoDate,
  priority: z.number().int().min(1).max(1000).default(100),
  expectedReturnRateMicro: z.number().int().min(-500_000).max(1_000_000),
  monthlyContributionPaise: paise,
  status: z.enum(['active', 'achieved', 'paused', 'archived']).default('active'),
  notes: z.string().max(2000).nullable().optional(),
})

const goalContribution = z.object({
  ...syncEnvelope,
  goalId: z.string().uuid(),
  amountPaise: paise,
  contributedOn: isoDate,
  source: z.enum(['manual', 'sip_linked', 'bonus', 'windfall', 'rebalance']).default('manual'),
  note: z.string().max(200).nullable().optional(),
})

const savedCalculation = z.object({
  ...syncEnvelope,
  calculatorKey: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  label: z.string().max(80).nullable().optional(),
  inputs: z.record(z.unknown()),
  outputs: z.record(z.unknown()),
  engineVersion: z.string().max(64),
  rulesetVersion: z.string().max(64).nullable().optional(),
  isPinned: z.boolean().default(false),
})

const creditHealthInput = z.object({
  ...syncEnvelope,
  activeLoanCount: z.number().int().min(0).max(50),
  creditCardCount: z.number().int().min(0).max(30),
  totalCardLimitPaise: paise,
  totalCardBalancePaise: paise,
  missedPayments12m: z.number().int().min(0).max(60),
  oldestAccountMonths: z.number().int().min(0).max(900),
  recentEnquiries6m: z.number().int().min(0).max(50),
  hasSecuredLoan: z.boolean().default(false),
  selfReportedAt: isoDate,
})

/**
 * Registered entities. The remaining `sync_entity_type` values are declared here
 * as NOT-YET-IMPLEMENTED rather than omitted, so the startup assertion below
 * fails loudly when someone adds an enum value and forgets the registry.
 */
export const SYNC_ENTITIES: readonly SyncEntity[] = [
  { table: 'goals', model: 'goal', schema: goal, identity: ['id'] },
  { table: 'goal_contributions', model: 'goalContribution', schema: goalContribution, identity: ['id'] },
  { table: 'saved_calculations', model: 'savedCalculation', schema: savedCalculation, identity: ['id'] },
  { table: 'credit_health_inputs', model: 'creditHealthInput', schema: creditHealthInput, identity: ['id'] },
]

/** Every value of the `sync_entity_type` enum (05 §3). */
export const SYNC_ENTITY_TYPES = [
  'user_profiles', 'expense_categories', 'budgets', 'budget_categories', 'transactions',
  'goals', 'goal_contributions', 'loans', 'loan_payments', 'emergency_funds',
  'retirement_plans', 'calendar_events', 'saved_calculations', 'credit_health_inputs',
  'assets', 'asset_valuations', 'liabilities', 'learning_progress', 'recommendation_events',
] as const

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number]

const byTable = new Map(SYNC_ENTITIES.map((e) => [e.table, e]))

export function findEntity(table: string): SyncEntity | undefined {
  return byTable.get(table)
}

/** Registered today; the rest return SYNC_TABLE_NOT_WRITABLE until implemented. */
export function implementedTables(): string[] {
  return SYNC_ENTITIES.map((e) => e.table)
}

/**
 * Fails at BOOT if the registry names a table the enum does not have. The
 * opposite direction (enum value with no registry entry) is legal and expected —
 * those are simply not implemented yet — but a registry entry with no enum value
 * would blow up only when a user first deleted such a row, which is far too late.
 */
export function assertRegistryMatchesEnum(): void {
  const enumSet = new Set<string>(SYNC_ENTITY_TYPES)
  const unknown = SYNC_ENTITIES.filter((e) => !enumSet.has(e.table)).map((e) => e.table)
  if (unknown.length) {
    throw new Error(
      `sync registry names tables absent from the sync_entity_type enum: ${unknown.join(', ')}. ` +
        'Add the enum value in a migration first (06 §8: enum changes are a two-migration operation).',
    )
  }
}
