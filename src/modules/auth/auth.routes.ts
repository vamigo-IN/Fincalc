import { Router } from 'express'
import { z } from 'zod'
import { ok } from '../../http/envelope.js'
import { CalcError } from '../../errors.js'
import { authenticate, rateLimit, requestCtx } from '../../http/middleware/auth.js'
import * as auth from './auth.service.js'

export const authRouter: Router = Router()

const parse = <T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> => {
  const r = schema.safeParse(body)
  if (!r.success) throw new CalcError(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`))
  return r.data
}

const registerSchema = z.object({
  email: z.string().email().max(254).toLowerCase().trim(),
  password: z.string().min(1).max(200),
  displayName: z.string().max(80).optional(),
})

const loginSchema = z.object({
  email: z.string().email().max(254).toLowerCase().trim(),
  password: z.string().min(1).max(200),
})

const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) })

authRouter.post('/register', rateLimit('auth'), async (req, res) => {
  const body = parse(registerSchema, req.body)
  const out = await auth.register(body, requestCtx(req))
  ok(res, { user: { id: out.userId, email: out.email, emailVerified: false }, tokens: out.tokens }, 201)
})

authRouter.post('/login', rateLimit('auth'), async (req, res) => {
  const body = parse(loginSchema, req.body)
  const out = await auth.login(body, requestCtx(req))
  ok(res, { user: { id: out.userId }, tokens: out.tokens })
})

authRouter.post('/refresh', rateLimit('refresh'), async (req, res) => {
  const body = parse(refreshSchema, req.body)
  ok(res, await auth.refresh(body.refreshToken, requestCtx(req)))
})

authRouter.post('/logout', rateLimit('write'), async (req, res) => {
  const body = parse(refreshSchema, req.body)
  await auth.logout(body.refreshToken, requestCtx(req))
  ok(res, { ok: true })
})

authRouter.post('/logout-all', authenticate, rateLimit('write'), async (req, res) => {
  const revoked = await auth.logoutAll(req.auth!.sub, requestCtx(req))
  ok(res, { revoked })
})

// ── /me ──────────────────────────────────────────────────────────────────────

export const meRouter: Router = Router()

meRouter.get('/', authenticate, rateLimit('read'), async (req, res) => {
  ok(res, await auth.me(req.auth!.sub))
})
