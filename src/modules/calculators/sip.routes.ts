import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { ok } from '../../http/envelope.js'
import { CalcError } from '../../errors.js'
import {
  project,
  requiredContribution,
  compareFrequencies,
  ENGINE_VERSION,
  type SipPlan,
  type Escalation,
} from '../../engines/sip.js'
import { wireToPaise, type Paise } from '../../engines/money.js'

export const sipRouter: Router = Router()

/** Money arrives as a string of integer paise (07 §2). A number is tolerated on input. */
const paiseInput = z.union([z.string().regex(/^-?\d+$/), z.number().int(), z.bigint()])
const paise = paiseInput.transform(wireToPaise)
/** See the note in goals.routes.ts: a default must be in WIRE shape, not bigint. */
const paiseOr0 = paiseInput.default('0').transform(wireToPaise)

const escalationSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({ type: z.literal('percent'), annualRateMicro: z.number().int(), capPaise: paise.optional() }),
    z.object({ type: z.literal('amount'), perYearPaise: paise, capPaise: paise.optional() }),
  ])
  .default({ type: 'none' })

const bodySchema = z
  .object({
    mode: z.enum(['project', 'required']).default('required'),
    targetPaise: paise.optional(),
    contributionPaise: paise.optional(),
    lumpsumPaise: paiseOr0,
    frequency: z.enum(['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly']).default('monthly'),
    timing: z.enum(['due', 'immediate']).default('due'),
    escalation: escalationSchema,
    years: z.number().positive(),
    expectedReturnMicro: z.number().int(),
    inflationMicro: z.number().int().optional(),
    compare: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'required' && v.targetPaise === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetPaise'], message: 'required when mode is "required"' })
    }
    if (v.mode === 'project' && v.contributionPaise === undefined && v.lumpsumPaise === 0n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contributionPaise'], message: 'required when mode is "project"' })
    }
  })

function toEscalation(e: z.infer<typeof escalationSchema>): Escalation {
  switch (e.type) {
    case 'none':
      return { type: 'none' }
    case 'percent':
      return { type: 'percent', annualMicro: e.annualRateMicro, ...(e.capPaise !== undefined ? { capPaise: e.capPaise as Paise } : {}) }
    case 'amount':
      return { type: 'amount', perYearPaise: e.perYearPaise as Paise, ...(e.capPaise !== undefined ? { capPaise: e.capPaise as Paise } : {}) }
  }
}

/**
 * POST /v1/calculators/sip/compute — docs/fincalc-2.0/19 §9.
 *
 * Note the default: mode "required" ("how much must I invest?"), because that is
 * what users asked for as the landing state. Everything else is optional, which
 * is what makes the progressive-disclosure UI possible without a second endpoint.
 *
 * The device normally computes this locally and offline via fincalc_core. This
 * endpoint exists for a future web client, for server-side reports, and as the
 * cross-check harness that proves the Dart and TypeScript engines agree (T1).
 */
sipRouter.post('/sip/compute', (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body)
  if (!parsed.success) {
    throw new CalcError(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`))
  }
  const b = parsed.data

  const plan: SipPlan = {
    contributionPaise: (b.contributionPaise ?? 0n) as Paise,
    lumpsumPaise: b.lumpsumPaise as Paise,
    frequency: b.frequency,
    timing: b.timing,
    escalation: toEscalation(b.escalation),
    years: b.years,
    expectedReturnMicro: b.expectedReturnMicro,
    ...(b.inflationMicro !== undefined ? { inflationMicro: b.inflationMicro } : {}),
  }

  const payload: Record<string, unknown> = { engineVersion: ENGINE_VERSION, mode: b.mode }

  if (b.mode === 'required') {
    const required = requiredContribution(plan, b.targetPaise as Paise)
    payload.requiredContributionPaise = required
    payload.projection = project({ ...plan, contributionPaise: required })
  } else {
    payload.projection = project(plan)
  }

  if (b.compare) {
    const contribution =
      b.mode === 'required' ? (payload.requiredContributionPaise as Paise) : (plan.contributionPaise as Paise)
    payload.frequencyComparison = compareFrequencies({ ...plan, contributionPaise: contribution })
    payload.frequencyNote =
      'Compared at equal annual outlay. At a steady assumed return, how often you invest ' +
      'changes the result by well under half a percent over 10 years — investing more often ' +
      'is very slightly worse here, because a monthly instalment starts earning a little ' +
      'sooner. Daily and weekly SIPs mainly help you match your cash flow. Their real-world ' +
      'edge comes from averaging out market ups and downs, which this calculator does not model.'
  }

  payload.disclaimer =
    'This is an educational estimate based on the figures you entered and an assumed constant ' +
    'return. Actual returns vary. It is not investment advice.'

  ok(res, payload)
})
