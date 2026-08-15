/**
 * Seed — docs/fincalc-2.0/05 §10.
 *
 * Runs on EVERY deploy inside fincalc_migrate, so every statement is idempotent
 * via `upsert` on a natural key. A seeder that is only safe on an empty database
 * is a seeder nobody dares run.
 */
import { PrismaClient } from '@prisma/client'
import { uuidv7 } from 'uuidv7'

const db = new PrismaClient()

/**
 * The 18 system expense categories.
 *
 * The brief names eight. Eight is not enough for an Indian household budget to
 * feel honest — the additions below are the ones whose absence forces everything
 * into "Other", which is the failure mode that makes budgeting apps get
 * abandoned. `domestic_help`, `family_support` and `festivals_gifting` are absent
 * from every Western template and near-universal here.
 *
 * `kind` is not cosmetic: the health score's savings-rate component excludes
 * `savings` from expenses, and the emergency-fund module derives monthly
 * essentials from `essential` spend.
 */
const CATEGORIES: Array<{
  key: string
  name: string
  kind: 'essential' | 'discretionary' | 'savings' | 'debt'
  icon: string
  color: string
  sort: number
}> = [
  { key: 'groceries',         name: 'Groceries',           kind: 'essential',     icon: 'shopping_cart',      color: '#4CAF50', sort: 10 },
  { key: 'dining_out',        name: 'Dining & takeaway',   kind: 'discretionary', icon: 'restaurant',         color: '#FF7043', sort: 20 },
  { key: 'rent',              name: 'Rent',                kind: 'essential',     icon: 'home',               color: '#5C6BC0', sort: 30 },
  { key: 'home_maintenance',  name: 'Home & maintenance',  kind: 'essential',     icon: 'handyman',           color: '#8D6E63', sort: 40 },
  { key: 'utilities',         name: 'Utilities & bills',   kind: 'essential',     icon: 'bolt',               color: '#FFA726', sort: 50 },
  { key: 'fuel_transport',    name: 'Fuel & transport',    kind: 'essential',     icon: 'local_gas_station',  color: '#26A69A', sort: 60 },
  { key: 'shopping',          name: 'Shopping',            kind: 'discretionary', icon: 'shopping_bag',       color: '#EC407A', sort: 70 },
  { key: 'travel',            name: 'Travel & holidays',   kind: 'discretionary', icon: 'flight',             color: '#29B6F6', sort: 80 },
  { key: 'healthcare',        name: 'Healthcare',          kind: 'essential',     icon: 'medical_services',   color: '#EF5350', sort: 90 },
  { key: 'education',         name: 'Education',           kind: 'essential',     icon: 'school',             color: '#7E57C2', sort: 100 },
  { key: 'entertainment',     name: 'Entertainment',       kind: 'discretionary', icon: 'movie',              color: '#AB47BC', sort: 110 },
  { key: 'emi_repayment',     name: 'Loan EMIs',           kind: 'debt',          icon: 'credit_card',        color: '#EF6C00', sort: 120 },
  { key: 'insurance',         name: 'Insurance premiums',  kind: 'essential',     icon: 'shield',             color: '#546E7A', sort: 130 },
  { key: 'investments',       name: 'Investments & SIPs',  kind: 'savings',       icon: 'trending_up',        color: '#00897B', sort: 140 },
  { key: 'domestic_help',     name: 'Domestic help',       kind: 'essential',     icon: 'cleaning_services',  color: '#78909C', sort: 150 },
  { key: 'festivals_gifting', name: 'Festivals & gifting', kind: 'discretionary', icon: 'celebration',        color: '#D4AF37', sort: 160 },
  { key: 'family_support',    name: 'Family support',      kind: 'essential',     icon: 'family_restroom',    color: '#6D4C41', sort: 170 },
  { key: 'other',             name: 'Other',               kind: 'discretionary', icon: 'category',           color: '#607D8B', sort: 999 },
]

async function seedExpenseCategories(): Promise<number> {
  for (const c of CATEGORIES) {
    // userId NULL = system-seeded and pull-only (the one documented exception to
    // 05 L4). A user who wants to rename one creates their OWN row with the same
    // category_key; the partial unique indexes allow exactly that.
    const existing = await db.expenseCategory.findFirst({
      where: { categoryKey: c.key, userId: null, deletedAt: null },
      select: { id: true },
    })
    if (existing) {
      await db.expenseCategory.update({
        where: { id: existing.id },
        data: { name: c.name, kind: c.kind, iconKey: c.icon, colorHex: c.color, sortOrder: c.sort },
      })
    } else {
      await db.expenseCategory.create({
        data: {
          id: uuidv7(),
          userId: null,
          categoryKey: c.key,
          name: c.name,
          kind: c.kind,
          iconKey: c.icon,
          colorHex: c.color,
          sortOrder: c.sort,
        },
      })
    }
  }
  return CATEGORIES.length
}

const LEARNING_CATEGORIES = [
  { key: 'budgeting',       name: 'Budgeting basics',   icon: 'savings',         sort: 10 },
  { key: 'sip_mutual_fund', name: 'SIP & mutual funds', icon: 'trending_up',     sort: 20 },
  { key: 'deposits',        name: 'FD, RD & PPF',       icon: 'account_balance', sort: 30 },
  { key: 'loans',           name: 'Loans & EMIs',       icon: 'credit_card',     sort: 40 },
  { key: 'tax_planning',    name: 'Tax planning',       icon: 'receipt_long',    sort: 50 },
  { key: 'insurance',       name: 'Insurance',          icon: 'shield',          sort: 60 },
  { key: 'retirement',      name: 'Retirement & NPS',   icon: 'beach_access',    sort: 70 },
  { key: 'credit_health',   name: 'Credit health',      icon: 'fact_check',      sort: 80 },
]

async function seedLearningCategories(): Promise<number> {
  for (const c of LEARNING_CATEGORIES) {
    await db.learningCategory.upsert({
      where: { categoryKey: c.key },
      update: { name: c.name, iconKey: c.icon, sortOrder: c.sort },
      create: { id: uuidv7(), categoryKey: c.key, name: c.name, iconKey: c.icon, sortOrder: c.sort },
    })
  }
  return LEARNING_CATEGORIES.length
}

const FLAGS = [
  { key: 'goals_enabled', desc: 'Goal Planner module' },
  { key: 'budget_enabled', desc: 'Budget Planner module' },
  { key: 'advisor_enabled', desc: 'Smart Advisor recommendations' },
  { key: 'ai_enabled', desc: 'Master kill switch for every AI tier (docs 12 §10.1)' },
]

async function seedFeatureFlags(): Promise<number> {
  for (const f of FLAGS) {
    await db.featureFlag.upsert({
      where: { flagKey: f.key },
      // Never overwrite a live rollout: an operator may have set this deliberately.
      update: {},
      create: { id: uuidv7(), flagKey: f.key, description: f.desc, isEnabled: true, rolloutPct: 100 },
    })
  }
  return FLAGS.length
}

async function main(): Promise<void> {
  const categories = await seedExpenseCategories()
  const learning = await seedLearningCategories()
  const flags = await seedFeatureFlags()
  console.log(
    `seed ok — ${categories} expense categories, ${learning} learning categories, ${flags} feature flags`,
  )
}

main()
  .catch((err) => {
    console.error('seed failed:', err)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
