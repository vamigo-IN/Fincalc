/**
 * Emit the SHARED golden-vector fixture consumed by BOTH engines.
 *
 * This is the T1 control made concrete (docs/fincalc-2.0/19 §10). The TypeScript
 * engine produces the file; the Dart engine in packages/fincalc_core must
 * reproduce every value from the same inputs. If a future change touches one
 * engine and not the other, CI fails here rather than users getting two
 * different answers for the same calculation.
 *
 *   npx tsx scripts/emit-golden-vectors.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { project, requiredContribution, compareFrequencies, ENGINE_VERSION, type SipPlan } from '../src/engines/sip.js'
import { toPaise } from '../src/engines/money.js'

const OUT = resolve(import.meta.dirname, '../../test_fixtures/sip_golden_vectors.json')

interface WirePlan {
  contributionPaise: string
  lumpsumPaise: string
  frequency: SipPlan['frequency']
  timing: SipPlan['timing']
  escalation:
    | { type: 'none' }
    | { type: 'percent'; annualMicro: number; capPaise?: string }
    | { type: 'amount'; perYearPaise: string; capPaise?: string }
  years: number
  expectedReturnMicro: number
  inflationMicro?: number
}

function toWirePlan(p: SipPlan): WirePlan {
  const esc =
    p.escalation.type === 'none'
      ? { type: 'none' as const }
      : p.escalation.type === 'percent'
        ? {
            type: 'percent' as const,
            annualMicro: p.escalation.annualMicro,
            ...(p.escalation.capPaise !== undefined ? { capPaise: p.escalation.capPaise.toString() } : {}),
          }
        : {
            type: 'amount' as const,
            perYearPaise: p.escalation.perYearPaise.toString(),
            ...(p.escalation.capPaise !== undefined ? { capPaise: p.escalation.capPaise.toString() } : {}),
          }
  return {
    contributionPaise: p.contributionPaise.toString(),
    lumpsumPaise: p.lumpsumPaise.toString(),
    frequency: p.frequency,
    timing: p.timing,
    escalation: esc,
    years: p.years,
    expectedReturnMicro: p.expectedReturnMicro,
    ...(p.inflationMicro !== undefined ? { inflationMicro: p.inflationMicro } : {}),
  }
}

const base: SipPlan = {
  contributionPaise: toPaise(10_000),
  lumpsumPaise: 0n,
  frequency: 'monthly',
  timing: 'due',
  escalation: { type: 'none' },
  years: 15,
  expectedReturnMicro: 120_000,
}

type Case =
  | { name: string; kind: 'project'; plan: WirePlan; expect: Record<string, unknown> }
  | { name: string; kind: 'required'; plan: WirePlan; targetPaise: string; expect: Record<string, unknown> }
  | { name: string; kind: 'compare'; plan: WirePlan; expect: Record<string, unknown> }

const cases: Case[] = []

function addProject(name: string, plan: SipPlan) {
  const r = project(plan)
  cases.push({
    name,
    kind: 'project',
    plan: toWirePlan(plan),
    expect: {
      maturityPaise: r.maturityPaise.toString(),
      totalInvestedPaise: r.totalInvestedPaise.toString(),
      totalReturnsPaise: r.totalReturnsPaise.toString(),
      lumpsumComponentPaise: r.lumpsumComponentPaise.toString(),
      contributionComponentPaise: r.contributionComponentPaise.toString(),
      finalInstalmentPaise: r.finalInstalmentPaise.toString(),
      capReached: r.capReached,
      capReachedInYear: r.capReachedInYear ?? null,
      inflationAdjustedMaturityPaise: r.inflationAdjustedMaturityPaise?.toString() ?? null,
      yearlyCount: r.yearly.length,
    },
  })
}

function addRequired(name: string, plan: SipPlan, targetRupees: number) {
  const target = toPaise(targetRupees)
  const req = requiredContribution(plan, target)
  const back = project({ ...plan, contributionPaise: req })
  cases.push({
    name,
    kind: 'required',
    plan: toWirePlan(plan),
    targetPaise: target.toString(),
    expect: {
      requiredContributionPaise: req.toString(),
      roundTripMaturityPaise: back.maturityPaise.toString(),
      meetsTarget: back.maturityPaise >= target,
    },
  })
}

function addCompare(name: string, plan: SipPlan) {
  const rows = compareFrequencies(plan, ['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly'])
  cases.push({
    name,
    kind: 'compare',
    plan: toWirePlan(plan),
    expect: {
      rows: rows.map((r) => ({
        frequency: r.frequency,
        instalmentPaise: r.instalmentPaise.toString(),
        maturityPaise: r.maturityPaise.toString(),
        totalInvestedPaise: r.totalInvestedPaise.toString(),
      })),
    },
  })
}

// ── the cases (docs 19 §10) ──────────────────────────────────────────────────
addProject('flat monthly, due — no regression for existing users', base)
addProject('flat monthly, immediate', { ...base, timing: 'immediate' })
addProject('10% annual step-up, uncapped', { ...base, escalation: { type: 'percent', annualMicro: 100_000 } })
addProject('10% step-up capped at ₹25,000', {
  ...base,
  escalation: { type: 'percent', annualMicro: 100_000, capPaise: toPaise(25_000) },
})
addProject('fixed +₹1,000/year step-up', { ...base, escalation: { type: 'amount', perYearPaise: toPaise(1_000) } })
addProject('lumpsum ₹5L + 10% step-up (superposition)', {
  ...base,
  lumpsumPaise: toPaise(500_000),
  escalation: { type: 'percent', annualMicro: 100_000 },
})
addProject('zero return', { ...base, expectedReturnMicro: 0, lumpsumPaise: toPaise(50_000) })
addProject('negative return', { ...base, expectedReturnMicro: -50_000 })
addProject('partial final year (7.5y)', { ...base, years: 7.5 })
addProject('daily, 40 years', { ...base, frequency: 'daily', contributionPaise: toPaise(100), years: 40 })
addProject('inflation-adjusted', { ...base, inflationMicro: 60_000 })
addProject('quarterly frequency', { ...base, frequency: 'quarterly', contributionPaise: toPaise(30_000) })

addRequired('inverse: ₹1 crore with 10% step-up', {
  ...base, contributionPaise: 0n, escalation: { type: 'percent', annualMicro: 100_000 },
}, 10_000_000)
addRequired('inverse: ₹50L flat (wireframe §7.1)', { ...base, contributionPaise: 0n }, 5_000_000)
addRequired('inverse: ₹50L with ₹5L lumpsum + 10% step-up (wireframe §7.2)', {
  ...base, contributionPaise: 0n, lumpsumPaise: toPaise(500_000),
  escalation: { type: 'percent', annualMicro: 100_000 },
}, 5_000_000)
addRequired('inverse: capped (bisection path)', {
  ...base, contributionPaise: 0n,
  escalation: { type: 'percent', annualMicro: 100_000, capPaise: toPaise(25_000) },
}, 10_000_000)

addCompare('frequency at equal annual outlay, due', {
  ...base, contributionPaise: toPaise(30_000), frequency: 'monthly', years: 10,
})
addCompare('frequency at equal annual outlay, immediate (ordering reverses)', {
  ...base, contributionPaise: toPaise(30_000), frequency: 'monthly', years: 10, timing: 'immediate',
})

const doc = {
  $comment:
    'SHARED FIXTURE — do not hand-edit. Generated from the TypeScript engine by ' +
    'server/scripts/emit-golden-vectors.ts and replayed by BOTH engines. If Dart and ' +
    'TypeScript ever disagree, CI fails here instead of users getting two different ' +
    'answers for the same calculation (docs/fincalc-2.0 T1).',
  engineVersion: ENGINE_VERSION,
  schemaVersion: 1,
  cases,
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n', 'utf8')
console.log(`wrote ${cases.length} cases -> ${OUT}`)
