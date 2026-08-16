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

/**
 * Self-reported credit answers.
 *
 * The five ANSWER fields are nullable, and null means "not answered" (migration
 * 0007). They are not optional-with-a-default, because a defaulted 0 in
 * `missedPayments12m` would read as the strongest possible status on the
 * highest-weighted factor — the module would award full marks on payment
 * history to a user who has answered nothing.
 *
 * `activeLoanCount` and `creditCardCount` keep their defaults: those are
 * derived from the loans module rather than asked, so 0 genuinely means zero.
 */
const creditHealthInput = z.object({
  ...syncEnvelope,
  activeLoanCount: z.number().int().min(0).max(50).default(0),
  creditCardCount: z.number().int().min(0).max(30).default(0),
  totalCardLimitPaise: paise.nullable().optional(),
  totalCardBalancePaise: paise.nullable().optional(),
  missedPayments12m: z.number().int().min(0).max(60).nullable().optional(),
  oldestAccountMonths: z.number().int().min(0).max(900).nullable().optional(),
  recentEnquiries6m: z.number().int().min(0).max(50).nullable().optional(),
  hasSecuredLoan: z.boolean().default(false),
  selfReportedAt: isoDate,
})


const budget = z.object({
  ...syncEnvelope,
  periodMonth: isoDate,
  incomePaise: paise,
  plannedSavingsPaise: paise,
  note: z.string().max(500).nullable().optional(),
  closedAt: isoTimestamp.nullable().optional(),
})

const budgetCategory = z.object({
  ...syncEnvelope,
  budgetId: z.string().uuid(),
  categoryId: z.string().uuid(),
  allocatedPaise: paise,
  rolloverEnabled: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(32767).default(500),
})

const transaction = z.object({
  ...syncEnvelope,
  budgetId: z.string().uuid().nullable().optional(),
  categoryId: z.string().uuid(),
  amountPaise: paise,
  txnType: z.enum(['expense', 'income', 'transfer']).default('expense'),
  source: z.enum(['manual', 'quick_add', 'recurring', 'bridge', 'import']).default('manual'),
  note: z.string().max(200).default(''),
  /**
   * REQUIRED, and part of the identity — see the `identity` field below.
   * An IST calendar date (05 L7): an expense entered at 23:50 on 31 March
   * belongs to FY 2025-26, and storing it as a timestamp then casting in UTC
   * would move it into the next financial year.
   */
  occurredOn: isoDate,
})

/**
 * The emergency fund is a SINGLETON per user — `ux_emergency_funds__user` is a
 * unique index on (user_id) WHERE deleted_at IS NULL (migration 0004). Two
 * devices each creating a fund offline will therefore collide on push, and the
 * loser is resolved by the same last-write-wins rule as any other row rather
 * than by a bespoke code path.
 *
 * `targetMonths` is bounded 3..12 to match `ck_emergency_funds__months`. Zod
 * rejecting it here turns a database CHECK violation — which surfaces as an
 * opaque sync failure — into a validation error naming the field.
 */
const emergencyFund = z.object({
  ...syncEnvelope,
  monthlyEssentialPaise: paise,
  dependants: z.number().int().min(0).max(20).default(0),
  incomeStability: z
    .enum(['salaried_stable', 'salaried_variable', 'self_employed', 'single_income'])
    .default('salaried_stable'),
  targetMonths: z.number().int().min(3).max(12).default(6),
  currentCorpusPaise: paise,
  monthlyFundingPaise: paise,
  linkedGoalId: z.string().uuid().nullable().optional(),
  /**
   * True while the essentials figure tracks logged spend. Once the user types
   * their own number this flips false and the derivation stops overwriting it —
   * without the flag, a month with few logged expenses would silently shrink
   * someone's target.
   */
  essentialsAutoDerived: z.boolean().default(true),
})

/**
 * A loan. Bounds mirror `ck_loans__*` (migration 0005) and the Dart engine's
 * validation, so the same input is rejected in the same place wherever it
 * arrives from.
 */
const loan = z.object({
  ...syncEnvelope,
  loanType: z.enum([
    'home', 'car', 'personal', 'education', 'gold', 'business',
    'consumer_durable', 'credit_card_emi', 'other',
  ]),
  lenderName: z.string().max(120).default(''),
  principalPaise: paise,
  /** 0 is legal — "no cost EMI" is a real product. */
  interestRateMicro: z.number().int().min(0).max(1_000_000),
  tenureMonths: z.number().int().min(1).max(480),
  startDate: isoDate,
  /** 29-31 are legal; the scheduler clamps to the month's last day. */
  emiDay: z.number().int().min(1).max(31).default(5),
  emiPaise: paise,
  outstandingPaise: paise,
  prepaymentTotalPaise: paise.optional(),
  status: z.enum(['active', 'closed', 'foreclosed', 'defaulted']).default('active'),
})

/**
 * One instalment, or one prepayment. `instalmentNo` is null for a prepayment —
 * `ck_loan_payments__prepayment_shape` enforces that the two never blur, because
 * the schedule cannot be reconstructed from rows that do.
 */
const loanPayment = z.object({
  ...syncEnvelope,
  loanId: z.string().uuid(),
  instalmentNo: z.number().int().min(1).max(480).nullable().optional(),
  dueDate: isoDate,
  paidOn: isoDate.nullable().optional(),
  amountPaise: paise,
  principalPaise: paise.optional(),
  interestPaise: paise.optional(),
  status: z
    .enum(['scheduled', 'paid', 'part_paid', 'missed', 'prepayment'])
    .default('scheduled'),
  isPrepayment: z.boolean().default(false),
})

const asset = z.object({
  ...syncEnvelope,
  name: z.string().min(1).max(120),
  assetClass: z.enum([
    'cash', 'bank_deposit', 'fd_rd', 'mutual_fund', 'equity', 'bonds_debt',
    'ppf_epf_nps', 'gold', 'real_estate', 'insurance_cash_value', 'other',
  ]),
  /** Zero is legal — an emptied account someone still tracks. Negative is not. */
  currentValuePaise: paise,
  asOfDate: isoDate,
  isLiquid: z.boolean().default(false),
  institution: z.string().max(120).nullable().optional(),
  linkedGoalId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
})

/**
 * A debt NOT tracked as a loan — a credit card balance, money owed to family.
 *
 * `sourceLoanId` is the double-counting guard: a loan in the loans module
 * already contributes its outstanding balance to net worth, and a liability row
 * mirroring it would halve the user's apparent net worth on data they entered
 * in good faith. `ux_liabilities__source_loan` allows at most one per loan.
 */
const liability = z.object({
  ...syncEnvelope,
  name: z.string().min(1).max(120),
  liabilityType: z.enum([
    'home_loan', 'car_loan', 'personal_loan', 'education_loan', 'gold_loan',
    'credit_card', 'consumer_durable', 'business_loan', 'informal', 'other',
  ]),
  outstandingPaise: paise,
  interestRateMicro: z.number().int().min(0).max(1_000_000).default(0),
  asOfDate: isoDate,
  sourceLoanId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
})

/**
 * A retirement plan. Bounds mirror `ck_retirement__ages` (migration 0004), and
 * the cross-field ordering is enforced here too — Zod can reject
 * `retirementAge <= currentAge` with a message naming the field, where the
 * database can only refuse the write.
 *
 * `ux_retirement_plans__primary` allows one primary plan per user; additional
 * scenarios are legal with `isPrimary: false`.
 */
const retirementPlan = z
  .object({
    ...syncEnvelope,
    name: z.string().max(120).default('My retirement'),
    currentAge: z.number().int().min(15).max(100),
    retirementAge: z.number().int().min(16).max(110),
    lifeExpectancy: z.number().int().min(17).max(120).default(85),
    currentCorpusPaise: paise,
    monthlyContributionPaise: paise,
    preReturnRateMicro: z.number().int().min(-500_000).max(1_000_000).default(120_000),
    postReturnRateMicro: z.number().int().min(-500_000).max(1_000_000).default(70_000),
    inflationRateMicro: z.number().int().min(0).max(500_000).default(60_000),
    desiredMonthlyIncomePaise: paise,
    epfBalancePaise: paise.optional(),
    npsBalancePaise: paise.optional(),
    isPrimary: z.boolean().default(true),
  })
  .refine((p) => p.retirementAge > p.currentAge, {
    message: 'retirementAge must be greater than currentAge',
    path: ['retirementAge'],
  })
  .refine((p) => p.lifeExpectancy > p.retirementAge, {
    message: 'lifeExpectancy must be greater than retirementAge',
    path: ['lifeExpectancy'],
  })

/**
 * User-created categories only. System rows (`user_id IS NULL`) are pull-only:
 * a push carrying one is rejected with ROW_NOT_OWNED, because the 18 seeded
 * defaults are shared by every account and a client must not be able to rename
 * them for everyone.
 */
const expenseCategory = z.object({
  ...syncEnvelope,
  categoryKey: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  name: z.string().min(1).max(60),
  kind: z.enum(['essential', 'discretionary', 'savings', 'debt']).default('discretionary'),
  iconKey: z.string().max(40).default('category'),
  colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#607D8B'),
  sortOrder: z.number().int().min(0).max(32767).default(500),
})

/**
 * Registered entities. The remaining `sync_entity_type` values are declared here
 * as NOT-YET-IMPLEMENTED rather than omitted, so the startup assertion below
 * fails loudly when someone adds an enum value and forgets the registry.
 */
export const SYNC_ENTITIES: readonly SyncEntity[] = [
  { table: 'goals', model: 'goal', schema: goal, identity: ['id'] },
  { table: 'expense_categories', model: 'expenseCategory', schema: expenseCategory, identity: ['id'] },
  { table: 'budgets', model: 'budget', schema: budget, identity: ['id'] },
  { table: 'budget_categories', model: 'budgetCategory', schema: budgetCategory, identity: ['id'] },
  // `occurredOn` is in the identity from v1, BEFORE the table is partitioned
  // (05 R3). Once transactions is RANGE-partitioned by month its primary key
  // becomes (occurred_on, id), and a payload that omitted the date would become
  // unroutable — making partitioning a breaking wire change instead of a
  // migration nobody notices.
  { table: 'transactions', model: 'transaction', schema: transaction, identity: ['occurredOn', 'id'] },
  { table: 'goal_contributions', model: 'goalContribution', schema: goalContribution, identity: ['id'] },
  { table: 'emergency_funds', model: 'emergencyFund', schema: emergencyFund, identity: ['id'] },
  { table: 'loans', model: 'loan', schema: loan, identity: ['id'] },
  { table: 'loan_payments', model: 'loanPayment', schema: loanPayment, identity: ['id'] },
  { table: 'assets', model: 'asset', schema: asset, identity: ['id'] },
  { table: 'liabilities', model: 'liability', schema: liability, identity: ['id'] },
  { table: 'retirement_plans', model: 'retirementPlan', schema: retirementPlan, identity: ['id'] },
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
