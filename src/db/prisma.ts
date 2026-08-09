import { PrismaClient, Prisma } from '@prisma/client'
import { config } from '../config.js'
import { logger } from '../obs/logger.js'

/**
 * The UNSCOPED client. Deliberately not the default export and deliberately
 * named so every call site is greppable. Application code uses `forUser()`.
 */
export const unsafeSystemClient = new PrismaClient({
  log: config.isProd ? ['warn', 'error'] : ['warn', 'error'],
})

let dbReady = false

export async function connectPrisma(): Promise<void> {
  try {
    await unsafeSystemClient.$connect()
    dbReady = true
    logger.info('prisma.ready')
  } catch (err) {
    logger.error({ err }, 'prisma.connect_failed — degraded mode')
  }
}

export function prismaHealthy(): boolean {
  return dbReady
}

/**
 * Tables whose every row is owned by exactly one user (docs 05 L4).
 * Every one has a `userId` column.
 */
const USER_OWNED = new Set([
  'UserProfile', 'UserDevice', 'Goal', 'GoalContribution', 'Budget', 'BudgetCategory',
  'Transaction', 'Asset', 'AssetValuation', 'Liability', 'Loan', 'LoanPayment',
  'EmergencyFund', 'RetirementPlan', 'NetWorthSnapshot', 'FinancialSnapshot', 'HealthScore',
  'AdvisorRecommendation', 'RecommendationEvent', 'CreditHealthInput', 'CreditHealthAssessment',
  'CalendarEvent', 'Notification', 'NotificationToken', 'LearningProgress',
  'SavedCalculation', 'Report', 'ReportArtifact', 'Subscription', 'Entitlement',
])

/** Shared or system-owned: read without a tenancy filter. */
const SHARED = new Set([
  'User', 'ExpenseCategory', 'LearningCategory', 'LearningArticle', 'AdvisorRule',
  'AdvisorRuleVersion', 'FeatureFlag', 'TaxRuleset', 'ReferenceRate', 'AuditLog',
  'AuthAuditLog', 'RefreshToken', 'SyncState', 'SyncTombstone',
])

const SCOPED_READS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy'])
const SCOPED_WRITES = new Set(['updateMany', 'deleteMany'])

/**
 * A per-request client that injects `user_id` into every query on a user-owned
 * model, so an unscoped query is not merely discouraged — it is unrepresentable.
 *
 * Three properties make this a control rather than a convention (docs 05 §8):
 *  1. Unknown models THROW. Adding a table without classifying it fails in
 *     development instead of shipping an unscoped table to production.
 *  2. `findUnique` is absent from SCOPED_READS on purpose: Prisma rejects a
 *     non-unique field in its where-clause, so `userId` cannot be injected.
 *     Repositories must use `findFirst({ where: { id } })`.
 *  3. The unscoped client is exported only under an alarming name.
 */
export function forUser(userId: string) {
  return unsafeSystemClient.$extends({
    query: {
      $allModels: {
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: {
          model?: string
          operation: string
          args: unknown
          query: (a: unknown) => Promise<unknown>
        }) {
          if (!model || SHARED.has(model)) return query(args)

          if (!USER_OWNED.has(model)) {
            throw new Error(
              `Tenancy: model "${model}" is not classified in src/db/prisma.ts. ` +
                'Add it to USER_OWNED or SHARED before using it.',
            )
          }

          const a = args as Record<string, unknown>

          if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
            throw new Error(
              `Tenancy: ${operation} is banned on user-owned model "${model}" — ` +
                'userId cannot be injected into a unique where-clause. Use findFirst({ where: { id } }).',
            )
          }

          if (SCOPED_READS.has(operation) || SCOPED_WRITES.has(operation)) {
            a.where = { ...((a.where as object) ?? {}), userId }
          }

          if (operation === 'create' || operation === 'upsert') {
            if (operation === 'create') {
              a.data = { ...((a.data as object) ?? {}), userId }
            } else {
              a.where = { ...((a.where as object) ?? {}) }
              a.create = { ...((a.create as object) ?? {}), userId }
            }
          }

          if (operation === 'createMany') {
            const rows = Array.isArray(a.data) ? a.data : [a.data]
            a.data = rows.map((r) => ({ ...(r as object), userId }))
          }

          if (operation === 'update' || operation === 'delete') {
            // Single-row update/delete addresses a unique key; scope it by
            // rewriting to the *Many form so the userId predicate applies.
            throw new Error(
              `Tenancy: use ${operation}Many on user-owned model "${model}" so the userId filter is enforced.`,
            )
          }

          // ExpenseCategory carries a generated column Prisma will try to write.
          if (model === 'ExpenseCategory' && (operation === 'create' || operation === 'createMany')) {
            const strip = (o: unknown) => {
              const c = { ...(o as Record<string, unknown>) }
              delete c.isSystem
              return c
            }
            a.data = Array.isArray(a.data) ? a.data.map(strip) : strip(a.data)
          }

          return query(a)
        },
      },
    },
  })
}

export type ScopedClient = ReturnType<typeof forUser>
export { Prisma }
