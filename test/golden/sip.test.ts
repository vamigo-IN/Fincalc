/**
 * SIP golden vectors — docs/fincalc-2.0/19 §10.
 *
 * Every expected value here was produced by INDEPENDENT recomputation (Python,
 * 2026-08-09) before the TypeScript existed, and the step-up cases were
 * cross-checked against the closed form. These same vectors must later be run by
 * the Dart suite in fincalc_core — that shared fixture is the T1 control that
 * stops the two engines diverging.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  project,
  requiredContribution,
  compareFrequencies,
  PERIODS_PER_YEAR,
  type SipPlan,
} from '../../src/engines/sip.js'
import { toPaise, formatIndian } from '../../src/engines/money.js'
import { CalcError } from '../../src/errors.js'

/** Assert two paise amounts agree to within `tolerance` paise. */
function nearPaise(actual: bigint, expectedRupees: number, tolerance = 1n, label = '') {
  const expected = toPaise(expectedRupees)
  const diff = actual > expected ? actual - expected : expected - actual
  assert.ok(
    diff <= tolerance,
    `${label}\n  expected ~${formatIndian(expected)}\n  actual    ${formatIndian(actual)}\n  diff      ${diff} paise`,
  )
}

const base: SipPlan = {
  contributionPaise: toPaise(10_000),
  lumpsumPaise: 0n,
  frequency: 'monthly',
  timing: 'due',
  escalation: { type: 'none' },
  years: 15,
  expectedReturnMicro: 120_000, // 12 %
}

describe('SIP — flat (no regression for existing users)', () => {
  test('₹10,000/mo · 12% · 15y, annuity-due', () => {
    const r = project(base)
    nearPaise(r.maturityPaise, 5_045_760.0, 2n, 'flat SIP maturity')
    assert.equal(r.totalInvestedPaise, toPaise(1_800_000))
    assert.equal(r.capReached, false)
  })

  test('timing: immediate is lower than due', () => {
    const due = project(base)
    const imm = project({ ...base, timing: 'immediate' })
    assert.ok(imm.maturityPaise < due.maturityPaise)
  })
})

describe('SIP — top-up (step-up)', () => {
  test('10% annual step-up, uncapped', () => {
    const r = project({ ...base, escalation: { type: 'percent', annualMicro: 100_000 } })
    nearPaise(r.maturityPaise, 8_683_849.43, 2n, 'step-up maturity')
    nearPaise(r.totalInvestedPaise, 3_812_697.8, 2n, 'step-up invested')
    nearPaise(r.finalInstalmentPaise, 10_000 * Math.pow(1.1, 14), 2n, 'final instalment')
    assert.equal(r.capReached, false)
  })

  test('closed form agrees with the iteration', () => {
    // FV = P·A·(1+i)^(12(Y−1))·Σ qᵏ  — the oracle, never used in production code.
    const P = 10_000, i = 0.12 / 12, Y = 15, g = 0.1
    const A = ((Math.pow(1 + i, 12) - 1) / i) * (1 + i)
    const q = (1 + g) / Math.pow(1 + i, 12)
    const S = Math.abs(q - 1) < 1e-12 ? Y : (1 - Math.pow(q, Y)) / (1 - q)
    const closed = P * A * Math.pow(1 + i, 12 * (Y - 1)) * S

    const iter = project({ ...base, escalation: { type: 'percent', annualMicro: 100_000 } })
    nearPaise(iter.maturityPaise, closed, 2n, 'iteration vs closed form')
  })

  test('10% step-up capped at ₹25,000 — cap binds in year 11', () => {
    const r = project({
      ...base,
      escalation: { type: 'percent', annualMicro: 100_000, capPaise: toPaise(25_000) },
    })
    nearPaise(r.maturityPaise, 8_192_286.55, 2n, 'capped maturity')
    assert.equal(r.capReached, true)
    assert.equal(r.capReachedInYear, 11)
    assert.equal(r.finalInstalmentPaise, toPaise(25_000))
  })

  test('fixed +₹1,000/year step-up', () => {
    const r = project({ ...base, escalation: { type: 'amount', perYearPaise: toPaise(1_000) } })
    nearPaise(r.maturityPaise, 7_509_280.63, 2n, 'fixed step-up maturity')
    assert.equal(r.finalInstalmentPaise, toPaise(24_000))
  })
})

describe('SIP — combined lumpsum + step-up (19 §3.4)', () => {
  test('₹5L lumpsum + ₹10,000/mo with 10% step-up', () => {
    const r = project({
      ...base,
      lumpsumPaise: toPaise(500_000),
      escalation: { type: 'percent', annualMicro: 100_000 },
    })
    nearPaise(r.maturityPaise, 11_681_750.42, 3n, 'combined total')
    nearPaise(r.lumpsumComponentPaise, 2_997_900.99, 2n, 'lumpsum component')
    nearPaise(r.contributionComponentPaise, 8_683_849.43, 3n, 'SIP component')
    // superposition must hold exactly
    assert.equal(r.lumpsumComponentPaise + r.contributionComponentPaise, r.maturityPaise)
  })
})

describe('SIP — frequency (19 §4): the counter-intuitive result', () => {
  const plan: SipPlan = {
    ...base,
    contributionPaise: toPaise(30_000),
    frequency: 'monthly',
    years: 10,
  }

  test('at equal annual outlay, MONTHLY beats daily (annuity-due)', () => {
    const rows = compareFrequencies(plan, ['monthly', 'weekly', 'daily'])
    const m = rows.find((r) => r.frequency === 'monthly')!
    const w = rows.find((r) => r.frequency === 'weekly')!
    const d = rows.find((r) => r.frequency === 'daily')!

    nearPaise(m.maturityPaise, 6_970_172.29, 3n, 'monthly')
    nearPaise(w.maturityPaise, 6_962_620.8, 3n, 'weekly')
    nearPaise(d.maturityPaise, 6_960_674.3, 3n, 'daily')

    assert.ok(m.maturityPaise > w.maturityPaise && w.maturityPaise > d.maturityPaise)
    // and the gap is noise: well under 0.2 %
    assert.ok(Math.abs(d.deltaVsMonthlyPct) < 0.2, `daily delta ${d.deltaVsMonthlyPct}%`)
  })

  test('with immediate timing the ordering REVERSES — the claim is an artefact', () => {
    const rows = compareFrequencies({ ...plan, timing: 'immediate' }, ['monthly', 'weekly', 'daily'])
    const m = rows.find((r) => r.frequency === 'monthly')!
    const d = rows.find((r) => r.frequency === 'daily')!
    nearPaise(m.maturityPaise, 6_901_160.68, 3n, 'monthly immediate')
    nearPaise(d.maturityPaise, 6_958_386.61, 3n, 'daily immediate')
    assert.ok(d.maturityPaise > m.maturityPaise, 'daily should win under immediate timing')
  })

  test('comparison always normalises annual outlay — the unfair version is unrepresentable', () => {
    const rows = compareFrequencies(plan)
    const annual = rows.map((r) => Number(r.instalmentPaise) * r.periodsPerYear)
    for (const a of annual) assert.ok(Math.abs(a - annual[0]!) < 100, 'annual outlay must match across rows')
  })
})

describe('SIP — inverse (the default mode, 19 §5–6)', () => {
  /**
   * The guarantee, asserted on every inverse case: a required figure must NEVER
   * land the user short. Instalments are whole paise, so the answer is rounded
   * UP; at a 15-year horizon a half-paisa rounding compounds to a few rupees of
   * deliberate overshoot. The bound is derived from the plan's own growth factor
   * rather than being a magic constant.
   */
  function assertMeetsTarget(plan: SipPlan, targetRupees: number, label: string) {
    const target = toPaise(targetRupees)
    const req = requiredContribution({ ...plan, contributionPaise: 0n }, target)
    const back = project({ ...plan, contributionPaise: req })

    assert.ok(
      back.maturityPaise >= target,
      `${label}: must never undershoot — got ${formatIndian(back.maturityPaise)} for ${formatIndian(target)}`,
    )

    // Bound the overshoot by the LOCAL sensitivity — what one more paisa of
    // instalment is worth at this solution. A global unit factor would be wrong
    // for a capped plan, where a large probe instalment is clipped to the cap.
    const oneLess = project({ ...plan, contributionPaise: req - 1n })
    const perPaise = Number(back.maturityPaise - oneLess.maturityPaise)
    const overshoot = Number(back.maturityPaise - target)
    assert.ok(
      overshoot <= perPaise * 2,
      `${label}: overshoot ${overshoot} paise exceeds 2× one paisa of instalment (${perPaise})`,
    )
    return req
  }

  test('uncapped: linear, never undershoots', () => {
    const plan: SipPlan = { ...base, contributionPaise: 0n, escalation: { type: 'percent', annualMicro: 100_000 } }
    const req = assertMeetsTarget(plan, 10_000_000, '₹1 crore with 10% step-up')
    nearPaise(req, 11_515.63, 1n, 'required starting SIP')
  })

  test('wireframe §7.1 — ₹50L, 15y, 12%, flat', () => {
    const req = assertMeetsTarget({ ...base, contributionPaise: 0n }, 5_000_000, 'flat ₹50L')
    nearPaise(req, 9_909.31, 1n, 'required flat SIP')
  })

  test('wireframe §7.2 — ₹50L with ₹5L lumpsum and 10% step-up', () => {
    const plan: SipPlan = {
      ...base,
      contributionPaise: 0n,
      lumpsumPaise: toPaise(500_000),
      escalation: { type: 'percent', annualMicro: 100_000 },
    }
    const req = assertMeetsTarget(plan, 5_000_000, '₹50L with lumpsum + step-up')
    nearPaise(req, 2_305.55, 1n, 'required starting SIP (ceiled)')

    const back = project({ ...plan, contributionPaise: req })
    nearPaise(back.lumpsumComponentPaise, 2_997_900.99, 2n, 'lumpsum grows to')
  })

  test('capped: bisection converges and still never undershoots', () => {
    const plan: SipPlan = {
      ...base,
      contributionPaise: 0n,
      escalation: { type: 'percent', annualMicro: 100_000, capPaise: toPaise(25_000) },
    }
    assertMeetsTarget(plan, 10_000_000, 'capped ₹1 crore')
  })

  test('lumpsum alone already reaches the target → ₹0 required', () => {
    const plan: SipPlan = { ...base, contributionPaise: 0n, lumpsumPaise: toPaise(5_000_000) }
    assert.equal(requiredContribution(plan, toPaise(1_000_000)), 0n)
  })
})

describe('SIP — edge cases (19 §11)', () => {
  test('zero return: FV equals contributions plus lumpsum, no division by zero', () => {
    const r = project({ ...base, expectedReturnMicro: 0, lumpsumPaise: toPaise(50_000) })
    assert.equal(r.maturityPaise, toPaise(10_000 * 180 + 50_000))
    assert.equal(r.totalReturnsPaise, 0n)
  })

  test('negative return is modelled, not rejected', () => {
    const r = project({ ...base, expectedReturnMicro: -50_000 })
    assert.ok(r.maturityPaise < r.totalInvestedPaise)
  })

  test('partial final year', () => {
    const r = project({ ...base, years: 7.5 })
    assert.equal(r.yearly.length, 8) // 7 full years + the half
  })

  test('daily over 40 years is fast and finite', () => {
    const t0 = performance.now()
    const r = project({ ...base, frequency: 'daily', contributionPaise: toPaise(100), years: 40 })
    assert.ok(Number.isFinite(Number(r.maturityPaise)))
    assert.ok(performance.now() - t0 < 250, 'daily 40y should be well under 250ms')
  })

  test('inflation adjustment is applied to the RESULT, never the contributions', () => {
    const r = project({ ...base, inflationMicro: 60_000 })
    assert.ok(r.inflationAdjustedMaturityPaise! < r.maturityPaise)
    const expected = 5_045_760.0 / Math.pow(1.06, 15)
    nearPaise(r.inflationAdjustedMaturityPaise!, expected, 3n, 'real maturity')
  })

  test('invalid inputs raise CalcError, never NaN', () => {
    assert.throws(() => project({ ...base, years: 0 }), CalcError)
    assert.throws(() => project({ ...base, years: 200 }), CalcError)
    assert.throws(() => project({ ...base, contributionPaise: 0n, lumpsumPaise: 0n }), CalcError)
    assert.throws(() => project({ ...base, expectedReturnMicro: 5_000_000 }), CalcError)
    assert.throws(() => requiredContribution(base, 0n), CalcError)
  })

  test('periods-per-year table is the documented one', () => {
    assert.deepEqual(PERIODS_PER_YEAR, { daily: 365, weekly: 52, fortnightly: 26, monthly: 12, quarterly: 4 })
  })
})

describe('Indian formatting', () => {
  test('lakh/crore grouping', () => {
    assert.equal(formatIndian(toPaise(123456.78)), '₹1,23,456.78')
    assert.equal(formatIndian(toPaise(10_000_000)), '₹1,00,00,000.00')
    assert.equal(formatIndian(toPaise(999)), '₹999.00')
    assert.equal(formatIndian(toPaise(-5000)), '-₹5,000.00')
  })
})
