/**
 * SIP engine — docs/fincalc-2.0/19.
 *
 * One engine covers every feature the Play Store reviews asked for:
 *   "Daily SIP"          → frequency: 'daily'
 *   "Top-up SIP"         → escalation: { type: 'percent', annualMicro: 100000 }
 *   "Lumpsum + SIP + Top-up" → all three at once (superposition, §3.4)
 *
 * Computation is period-by-period ITERATION, never the closed form (19 §3.1).
 * The closed form has a removable singularity at (1+g) = (1+i)^12 and needs
 * special cases for caps and partial years; the iteration has none of that and
 * costs microseconds. The closed form lives in the tests as an oracle only.
 */
import { CalcError } from '../errors.js'
import { microToFraction, toPaise, toPaiseCeil, toRupees, type Paise, type RateMicro } from './money.js'

export type SipFrequency = 'daily' | 'weekly' | 'fortnightly' | 'monthly' | 'quarterly'
export type AnnuityTiming = 'due' | 'immediate'

export const PERIODS_PER_YEAR: Record<SipFrequency, number> = {
  daily: 365,
  weekly: 52,
  fortnightly: 26,
  monthly: 12,
  quarterly: 4,
}

export type Escalation =
  | { type: 'none' }
  | { type: 'percent'; annualMicro: RateMicro; capPaise?: Paise }
  | { type: 'amount'; perYearPaise: Paise; capPaise?: Paise }

export interface SipPlan {
  contributionPaise: Paise
  lumpsumPaise: Paise
  frequency: SipFrequency
  timing: AnnuityTiming
  escalation: Escalation
  years: number
  expectedReturnMicro: RateMicro
  inflationMicro?: RateMicro
}

export interface SipYearRow {
  year: number
  investedPaise: Paise
  valuePaise: Paise
  instalmentPaise: Paise
}

export interface SipResult {
  maturityPaise: Paise
  totalInvestedPaise: Paise
  totalReturnsPaise: Paise
  lumpsumComponentPaise: Paise
  contributionComponentPaise: Paise
  finalInstalmentPaise: Paise
  inflationAdjustedMaturityPaise?: Paise
  capReached: boolean
  capReachedInYear?: number
  yearly: SipYearRow[]
}

export const SIP_BOUNDS = {
  maxYears: 60,
  minReturnMicro: -500_000, //  -50 %
  maxReturnMicro: 1_000_000, // +100 %
  maxContributionPaise: 10_000_000_000n, // ₹10 crore per instalment
  maxLumpsumPaise: 1_000_000_000_000n, // ₹1000 crore
} as const

export const ENGINE_VERSION = 'fincalc_core/1.0.0'

// ─────────────────────────────────────────────────────────────────────────────

function validate(plan: SipPlan, opts: { requireContribution: boolean }): void {
  const errs: string[] = []
  if (plan.years <= 0) errs.push('years must be greater than 0')
  if (plan.years > SIP_BOUNDS.maxYears) errs.push(`years must not exceed ${SIP_BOUNDS.maxYears}`)
  if (plan.expectedReturnMicro < SIP_BOUNDS.minReturnMicro || plan.expectedReturnMicro > SIP_BOUNDS.maxReturnMicro) {
    errs.push('expectedReturn must be between -50% and +100%')
  }
  if (plan.contributionPaise < 0n) errs.push('contribution must not be negative')
  if (plan.lumpsumPaise < 0n) errs.push('lumpsum must not be negative')
  if (plan.contributionPaise > SIP_BOUNDS.maxContributionPaise) errs.push('contribution is too large')
  if (plan.lumpsumPaise > SIP_BOUNDS.maxLumpsumPaise) errs.push('lumpsum is too large')
  if (opts.requireContribution && plan.contributionPaise <= 0n && plan.lumpsumPaise <= 0n) {
    errs.push('provide a contribution or a lumpsum')
  }
  if (plan.escalation.type === 'percent') {
    const g = plan.escalation.annualMicro
    if (g < -500_000 || g > 1_000_000) errs.push('top-up rate must be between -50% and +100%')
  }
  if (errs.length) throw new CalcError(errs)
}

/** The instalment for a given plan-year index (0-based). Escalates on the ANNIVERSARY (19 §3.3). */
function instalmentFor(base: number, esc: Escalation, yearIndex: number): number {
  let amount: number
  switch (esc.type) {
    case 'none':
      return base
    case 'percent':
      amount = base * Math.pow(1 + microToFraction(esc.annualMicro), yearIndex)
      break
    case 'amount':
      amount = base + toRupees(esc.perYearPaise) * yearIndex
      break
  }
  if (esc.capPaise !== undefined) {
    const cap = toRupees(esc.capPaise)
    if (amount > cap) return cap
  }
  return amount
}

function hasCap(esc: Escalation): boolean {
  return esc.type !== 'none' && esc.capPaise !== undefined && esc.capPaise > 0n
}

/**
 * The single accumulation loop. Everything else in this file calls it.
 * `contributionRupees` is passed separately so the inverse (§5) can evaluate the
 * plan at a unit contribution without allocating a new plan object.
 */
function accumulate(
  plan: SipPlan,
  contributionRupees: number,
): { balance: number; invested: number; finalInstalment: number; capYear?: number; yearly: SipYearRow[] } {
  const ppy = PERIODS_PER_YEAR[plan.frequency]
  const r = microToFraction(plan.expectedReturnMicro) / ppy
  const n = Math.round(plan.years * ppy)

  let balance = toRupees(plan.lumpsumPaise)
  let invested = 0
  let finalInstalment = 0
  let capYear: number | undefined
  const yearly: SipYearRow[] = []

  const capRupees = hasCap(plan.escalation) ? toRupees((plan.escalation as { capPaise: Paise }).capPaise) : undefined

  for (let k = 0; k < n; k++) {
    const yearIndex = Math.floor(k / ppy)
    const amount = instalmentFor(contributionRupees, plan.escalation, yearIndex)

    if (capRupees !== undefined && capYear === undefined && amount >= capRupees && contributionRupees > 0) {
      // The cap binds from this plan-year onward.
      const uncapped = instalmentFor(contributionRupees, { ...plan.escalation, capPaise: undefined } as Escalation, yearIndex)
      if (uncapped > capRupees) capYear = yearIndex + 1
    }

    balance = plan.timing === 'due' ? (balance + amount) * (1 + r) : balance * (1 + r) + amount
    invested += amount
    finalInstalment = amount

    if ((k + 1) % ppy === 0 || k === n - 1) {
      yearly.push({
        year: Math.floor(k / ppy) + 1,
        investedPaise: toPaise(invested),
        valuePaise: toPaise(balance),
        instalmentPaise: toPaise(amount),
      })
    }
  }

  return { balance, invested, finalInstalment, ...(capYear !== undefined ? { capYear } : {}), yearly }
}

// ─────────────────────────────────────────────────────────────────────────────

/** Forward mode: "I invest X — what will I get?" */
export function project(plan: SipPlan): SipResult {
  validate(plan, { requireContribution: true })

  const contribution = toRupees(plan.contributionPaise)
  const run = accumulate(plan, contribution)

  // Split the lumpsum out by re-running with no contribution (19 §3.4 superposition).
  const lumpsumOnly = accumulate({ ...plan, contributionPaise: 0n }, 0)

  const maturityPaise = toPaise(run.balance)
  const totalInvestedPaise = toPaise(run.invested) + plan.lumpsumPaise
  const lumpsumComponentPaise = toPaise(lumpsumOnly.balance)

  const result: SipResult = {
    maturityPaise,
    totalInvestedPaise,
    totalReturnsPaise: maturityPaise - totalInvestedPaise,
    lumpsumComponentPaise,
    contributionComponentPaise: maturityPaise - lumpsumComponentPaise,
    finalInstalmentPaise: toPaise(run.finalInstalment),
    capReached: run.capYear !== undefined,
    ...(run.capYear !== undefined ? { capReachedInYear: run.capYear } : {}),
    yearly: run.yearly,
  }

  if (plan.inflationMicro !== undefined && plan.inflationMicro !== 0) {
    const real = run.balance / Math.pow(1 + microToFraction(plan.inflationMicro), plan.years)
    result.inflationAdjustedMaturityPaise = toPaise(real)
  }

  return result
}

/**
 * Inverse mode — the DEFAULT in the UI (19 §6): "I want ₹X — how much must I invest?"
 *
 * FV is linear in the contribution, so this is a division, not a solver (19 §5).
 * The single exception is a cap: min(amount, cap) is not homogeneous in P, so a
 * capped plan falls back to bisection. Callers never choose; the engine decides.
 */
export function requiredContribution(plan: SipPlan, targetPaise: Paise): Paise {
  validate(plan, { requireContribution: false })
  if (targetPaise <= 0n) throw new CalcError(['target must be greater than 0'])

  const lumpsumFv = accumulate({ ...plan, contributionPaise: 0n }, 0).balance
  const target = toRupees(targetPaise)
  const remaining = target - lumpsumFv
  if (remaining <= 0) return 0n // the lumpsum alone already gets there

  if (!hasCap(plan.escalation)) {
    const unitPlan: SipPlan = { ...plan, lumpsumPaise: 0n }
    const unit = accumulate(unitPlan, 1).balance
    if (unit <= 0) throw new CalcError(['this plan can never reach the target'])
    // Ceil, not round — see toPaiseCeil. A required figure must never land short.
    return toPaiseCeil(remaining / unit)
  }

  return bisect(plan, target)
}

/**
 * ~60 iterations of bisection; each is a sub-millisecond forward pass.
 * `hi` is always kept on the side that MEETS the target, so ceiling `hi` at the
 * end preserves the never-undershoot guarantee.
 */
function bisect(plan: SipPlan, targetRupees: number): Paise {
  let lo = 0
  let hi = targetRupees // an instalment this large always overshoots
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    const fv = accumulate(plan, mid).balance
    if (fv < targetRupees) lo = mid
    else hi = mid
    if (hi - lo < 0.0005) break // a twentieth of a paisa; iterations are free
  }
  return toPaiseCeil(hi)
}

// ─────────────────────────────────────────────────────────────────────────────

export interface FrequencyComparison {
  frequency: SipFrequency
  instalmentPaise: Paise
  periodsPerYear: number
  maturityPaise: Paise
  totalInvestedPaise: Paise
  deltaVsMonthlyPaise: Paise
  deltaVsMonthlyPct: number
}

/**
 * Compare frequencies at EQUAL ANNUAL OUTLAY (19 §4.1).
 *
 * Normalisation happens here, in the engine, so the misleading comparison a user
 * would otherwise make — ₹1,000/day against ₹30,000/month, where daily "wins" only
 * because it invested ₹50,000 more — is not expressible through this API.
 *
 * Expect the differences to be tiny (~0.1 %) and to REVERSE with `timing`. That is
 * the honest finding, not a bug: see 19 §4.
 */
export function compareFrequencies(plan: SipPlan, frequencies?: SipFrequency[]): FrequencyComparison[] {
  validate(plan, { requireContribution: true })

  const annualOutlay = toRupees(plan.contributionPaise) * PERIODS_PER_YEAR[plan.frequency]
  const list = frequencies ?? (['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly'] as SipFrequency[])

  const rows = list.map((frequency) => {
    const ppy = PERIODS_PER_YEAR[frequency]
    const perInstalment = annualOutlay / ppy
    const run = accumulate({ ...plan, frequency, contributionPaise: toPaise(perInstalment) }, perInstalment)
    return {
      frequency,
      instalmentPaise: toPaise(perInstalment),
      periodsPerYear: ppy,
      maturityPaise: toPaise(run.balance),
      totalInvestedPaise: toPaise(run.invested) + plan.lumpsumPaise,
      deltaVsMonthlyPaise: 0n,
      deltaVsMonthlyPct: 0,
    }
  })

  const monthly = rows.find((r) => r.frequency === 'monthly')
  if (monthly) {
    for (const row of rows) {
      row.deltaVsMonthlyPaise = row.maturityPaise - monthly.maturityPaise
      row.deltaVsMonthlyPct =
        monthly.maturityPaise === 0n
          ? 0
          : Number(row.maturityPaise - monthly.maturityPaise) / Number(monthly.maturityPaise) * 100
    }
  }

  return rows
}
