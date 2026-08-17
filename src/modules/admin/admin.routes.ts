import { Router, type Request, type Response, type NextFunction } from 'express'
import { uuidv7 } from 'uuidv7'
import { unsafeSystemClient as db } from '../../db/prisma.js'
import { redis, redisHealthy } from '../../db/redis.js'
import { config } from '../../config.js'
import { logger, ipPrefix } from '../../obs/logger.js'
import {
  verifyPassword,
  hashPassword,
  assertPasswordAcceptable,
  burnPasswordVerification,
} from '../auth/crypto.js'
import { AppError } from '../../errors.js'
import { upstreamCallsToday } from '../reference/fx.service.js'
import { layout, loginPage, accountPage, card, table, esc, inr, when } from './views.js'
import {
  createSession,
  currentAdmin,
  destroySession,
  destroyAllSessionsFor,
  readSessionId,
  setSessionCookie,
  clearSessionCookie,
  requireCsrf,
  csrfField,
  loginAttemptsExceeded,
  lockoutUntil,
  LOCKOUT_THRESHOLD,
  noStore,
} from './admin.security.js'

export const adminRouter: Router = Router()
adminRouter.use(noStore)
adminRouter.use(express_urlencoded())

/** Tiny urlencoded body parser so we do not pull in another dependency. */
function express_urlencoded() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.is('application/x-www-form-urlencoded')) return next()
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 64_000) req.destroy()
    })
    req.on('end', () => {
      req.body = Object.fromEntries(new URLSearchParams(raw))
      next()
    })
  }
}

// ── session ──────────────────────────────────────────────────────────────────
// A signed cookie, not the mobile JWT: the browser flow wants a cookie, and
// keeping the two separate means an XSS on the admin pages cannot mint an app
// token. Sessions live in Redis so "sign out" is immediate and server-side.
//
// Everything that enforces the session lives in admin.security.ts.

const requireAdminPage = async (req: Request, res: Response, next: NextFunction) => {
  const admin = await currentAdmin(req)
  if (!admin) {
    clearSessionCookie(res)
    return res.redirect('/admin/login')
  }
  req.admin = admin
  next()
}

// ── auth ─────────────────────────────────────────────────────────────────────

adminRouter.get('/login', async (req, res) => {
  if (await currentAdmin(req)) return res.redirect('/admin')
  res.type('html').send(loginPage())
})

/**
 * A deliberately uniform failure.
 *
 * Every rejected login returns the same message, the same status and — via
 * burnPasswordVerification — roughly the same timing. The previous version
 * returned immediately when the email was not on the allowlist, while a real
 * admin email spent ~155ms in bcrypt. That gap is an oracle: it reveals which
 * address is the admin, which is the one thing an attacker needs before they
 * start guessing.
 */
adminRouter.post('/login', async (req, res) => {
  const email = String(req.body?.email ?? '').toLowerCase().trim()
  const password = String(req.body?.password ?? '')

  const deny = async (reason: string, userId?: string) => {
    logger.warn({ reason, ip: ipPrefix(req.ip) }, 'admin.login_failed')
    // Audited to the DATABASE, not only to the log stream: a brute-force run
    // should be visible to whoever reads the audit trail, and log retention is
    // shorter than the audit table's.
    await db.auditLog
      .create({
        data: {
          actorType: 'admin',
          actorId: userId ?? null,
          action: 'admin.login_failed',
          after: { reason } as object,
          requestId: req.requestId,
          ipPrefix: ipPrefix(req.ip) ?? null,
        },
      })
      .catch(() => null)
    res.status(401).type('html').send(loginPage('Those details did not work.'))
  }

  // Per-IP ceiling first, before any database work, so a flood cannot turn the
  // login form into a way to make the API do bcrypt on demand.
  if (await loginAttemptsExceeded(req)) {
    logger.warn({ ip: ipPrefix(req.ip) }, 'admin.login_rate_limited')
    res.status(429).type('html').send(loginPage('Too many attempts. Try again in 15 minutes.'))
    return
  }

  const allowlisted = config.adminEmails.has(email)
  const user = allowlisted
    ? await db.user.findFirst({
        where: { email, deletedAt: null },
        select: {
          id: true, email: true, passwordHash: true, status: true,
          failedLoginCount: true, lockedUntil: true,
        },
      })
    : null

  if (!user) {
    // Same work as the success path, so the response time does not disclose
    // whether the address exists or is on the allowlist.
    await burnPasswordVerification(password)
    return deny(allowlisted ? 'no_user' : 'not_admin')
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await burnPasswordVerification(password)
    return deny('locked', user.id)
  }
  if (user.status !== 'active') {
    await burnPasswordVerification(password)
    return deny('inactive', user.id)
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    // Per-ACCOUNT lockout, mirroring auth.service.ts. Without this the admin
    // form was an unlimited oracle against the same row the mobile login
    // protects — a distributed attack simply avoided the per-IP counter.
    const failed = user.failedLoginCount + 1
    await db.user.update({
      where: { id: user.id },
      data: { failedLoginCount: failed, lockedUntil: lockoutUntil(failed) },
    })
    return deny(failed >= LOCKOUT_THRESHOLD ? 'bad_password_locked' : 'bad_password', user.id)
  }

  if (!redisHealthy()) {
    // Fail closed. No session store means no revocation and no CSRF secret.
    res.status(503).type('html').send(loginPage('Session store unavailable. Try again shortly.'))
    return
  }

  await db.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  })

  const session = await createSession(user.id, user.email.toLowerCase())
  setSessionCookie(res, session.sid)
  await db.auditLog.create({
    data: {
      actorType: 'admin', actorId: user.id, action: 'admin.login',
      requestId: req.requestId, ipPrefix: ipPrefix(req.ip) ?? null,
    },
  })
  res.redirect('/admin')
})

adminRouter.post('/logout', async (req, res) => {
  // No CSRF token required to sign OUT: forcing a logout is not an attack worth
  // defending against, and rejecting it would strand anyone on a stale page.
  const sid = readSessionId(req)
  if (sid) await destroySession(sid)
  clearSessionCookie(res)
  res.redirect('/admin/login')
})

// Everything below requires a live, still-valid admin session AND — for POSTs —
// a matching CSRF token. Order matters: requireAdminPage populates req.admin,
// which requireCsrf compares against.
adminRouter.use(requireAdminPage)
adminRouter.use(requireCsrf)

// ── account ──────────────────────────────────────────────────────────────────
//
// This replaces scripts/reset-admin.ts. A password change now requires proving
// you already hold the password, from inside an authenticated session, over a
// CSRF-protected form — rather than shell access to the container, which is a
// completely different and much broader capability.

adminRouter.get('/account', (req, res) => {
  res.type('html').send(accountPage(req.admin!))
})

adminRouter.post('/account/password', async (req, res) => {
  const admin = req.admin!
  const current = String(req.body?.current ?? '')
  const next = String(req.body?.next ?? '')
  const confirm = String(req.body?.confirm ?? '')

  const fail = async (msg: string, reason: string) => {
    logger.warn({ reason, ip: ipPrefix(req.ip) }, 'admin.password_change_failed')
    await db.auditLog
      .create({
        data: {
          actorType: 'admin', actorId: admin.userId, action: 'admin.password_change_failed',
          after: { reason } as object, requestId: req.requestId, ipPrefix: ipPrefix(req.ip) ?? null,
        },
      })
      .catch(() => null)
    res.status(400).type('html').send(accountPage(admin, msg))
  }

  if (next !== confirm) return fail('The new passwords do not match.', 'mismatch')

  const user = await db.user.findFirst({
    where: { id: admin.userId, deletedAt: null },
    select: { id: true, passwordHash: true },
  })
  if (!user) return fail('Account not found.', 'no_user')

  // Proving possession of the CURRENT password is the point. Without it, any
  // route that leaves a session open — a borrowed laptop, an XSS — becomes a
  // permanent account takeover rather than a temporary one.
  if (!(await verifyPassword(current, user.passwordHash))) {
    return fail('Your current password is not correct.', 'bad_current')
  }
  if (next === current) {
    return fail('The new password must be different from the current one.', 'unchanged')
  }

  try {
    // Same policy as the mobile app: length bounds and a common-password list.
    assertPasswordAcceptable(next)
  } catch (err) {
    // `details` is always an array (it defaults to []), so `||` not `??` —
    // an empty list must fall through to the generic message, and '' is falsy
    // but not nullish.
    const details = err instanceof AppError ? (err.details as string[]) : []
    return fail(details.join('. ') || 'That password is not acceptable.', 'weak')
  }

  await db.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(next),
      // Rejects every access token issued before now.
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
    },
  })
  // And revoke the long-lived credentials the timestamp does not cover.
  await db.refreshToken.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  })

  // Every admin session including this one: a password change is what you do
  // when you believe someone else may have had access, so leaving any session
  // alive defeats the purpose. Signing back in is the confirmation it worked.
  await destroyAllSessionsFor(user.id)
  clearSessionCookie(res)

  await db.auditLog.create({
    data: {
      actorType: 'admin', actorId: user.id, action: 'admin.password_changed',
      requestId: req.requestId, ipPrefix: ipPrefix(req.ip) ?? null,
    },
  })

  res.type('html').send(loginPage('Password changed. Please sign in again.'))
})

// ── overview ─────────────────────────────────────────────────────────────────

adminRouter.get('/', async (_req, res) => {
  const [users, activeUsers, goals, subs, entitlements, recs, rules, flags, calls] = await Promise.all([
    db.user.count({ where: { deletedAt: null } }),
    db.user.count({ where: { deletedAt: null, lastLoginAt: { gte: new Date(Date.now() - 30 * 864e5) } } }),
    db.goal.count({ where: { deletedAt: null } }),
    db.subscription.count({ where: { status: { in: ['active', 'grace'] } } }),
    db.entitlement.count({ where: { revokedAt: null } }),
    db.advisorRecommendation.count({ where: { status: 'active' } }),
    db.advisorRule.count({ where: { status: 'active' } }),
    db.featureFlag.count({ where: { isEnabled: true } }),
    upstreamCallsToday(),
  ])

  const recent = await db.user.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, email: true, createdAt: true, lastLoginAt: true },
  })

  const budgetTag = calls < 0 ? 'warn' : calls > 30 ? 'bad' : 'ok'

  res.type('html').send(
    layout('Overview', '/admin', `
      <h1>Overview</h1>
      <div class="cards">
        ${card('Users', String(users), `${activeUsers} active in 30 days`)}
        ${card('Goals', String(goals))}
        ${card('Paying', String(subs), `${entitlements} live entitlements`)}
        ${card('Advisor', String(recs), `${rules} active rules`)}
        ${card('Feature flags on', String(flags))}
        ${card('FX calls today', `<span class="tag ${budgetTag}">${calls < 0 ? 'n/a' : calls}</span>`, 'budget ≤ 30/day')}
      </div>
      <h2>Newest accounts</h2>
      ${table(
        ['Email', 'Signed up', 'Last login', ''],
        recent.map(
          (u) => `<tr>
            <td>${esc(u.email)}</td>
            <td>${when(u.createdAt)}</td>
            <td>${when(u.lastLoginAt)}</td>
            <td><a href="/admin/users/${esc(u.id)}">Open</a></td>
          </tr>`,
        ),
      )}`),
  )
})

// ── users ────────────────────────────────────────────────────────────────────

adminRouter.get('/users', async (req, res) => {
  const q = String(req.query.q ?? '').trim()
  const users = await db.user.findMany({
    where: { deletedAt: null, ...(q ? { email: { contains: q, mode: 'insensitive' as const } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, email: true, status: true, createdAt: true, lastLoginAt: true,
              _count: { select: { goals: true, entitlements: true } } },
  })

  res.type('html').send(
    layout('Users', '/admin/users', `
      <h1>Users</h1>
      <form method="get" style="margin-bottom:1rem">
        <input name="q" value="${esc(q)}" placeholder="Search by email" style="min-width:260px">
        <button type="submit">Search</button>
      </form>
      ${table(
        ['Email', 'Status', '#Goals', '#Entitlements', 'Signed up', ''],
        users.map(
          (u) => `<tr>
            <td>${esc(u.email)}</td>
            <td><span class="tag ${u.status === 'active' ? 'ok' : 'warn'}">${esc(u.status)}</span></td>
            <td class="num">${u._count.goals}</td>
            <td class="num">${u._count.entitlements}</td>
            <td>${when(u.createdAt)}</td>
            <td><a href="/admin/users/${esc(u.id)}">Open</a></td>
          </tr>`,
        ),
      )}`),
  )
})

adminRouter.get('/users/:id', async (req, res) => {
  const user = await db.user.findUnique({
    where: { id: req.params.id },
    select: {
      id: true, email: true, status: true, createdAt: true, lastLoginAt: true, emailVerifiedAt: true,
      profile: { select: { displayName: true, city: true, stateCode: true } },
      entitlements: { where: { revokedAt: null }, select: { id: true, featureKey: true, source: true, expiresAt: true } },
      goals: { where: { deletedAt: null }, select: { id: true, name: true, targetAmountPaise: true, currentAmountPaise: true, status: true }, take: 25 },
      subscriptions: { select: { id: true, productId: true, status: true, currentPeriodEnd: true } },
    },
  })
  if (!user) return res.status(404).type('html').send(layout('Not found', '/admin/users', '<h1>No such user</h1>'))

  const csrf = csrfField(req.admin!)

  res.type('html').send(
    layout(user.email, '/admin/users', `
      <h1>${esc(user.email)}</h1>
      <div class="cards">
        ${card('Status', `<span class="tag ${user.status === 'active' ? 'ok' : 'warn'}">${esc(user.status)}</span>`)}
        ${card('Email verified', user.emailVerifiedAt ? '<span class="tag ok">yes</span>' : '<span class="tag warn">no</span>')}
        ${card('Signed up', when(user.createdAt))}
        ${card('Last login', when(user.lastLoginAt))}
      </div>

      <h2>Entitlements</h2>
      ${table(
        ['Feature', 'Source', 'Expires', ''],
        user.entitlements.map(
          (e) => `<tr>
            <td><code>${esc(e.featureKey)}</code></td>
            <td>${esc(e.source)}</td>
            <td>${when(e.expiresAt)}</td>
            <td><form class="inline" method="post" action="/admin/users/${esc(user.id)}/entitlements/${esc(e.id)}/revoke">
              ${csrf}<button class="ghost" type="submit">Revoke</button></form></td>
          </tr>`,
        ),
      )}
      <form method="post" action="/admin/users/${esc(user.id)}/entitlements" style="margin-top:.7rem">
        ${csrf}
        <select name="featureKey">
          <option value="pdf_export">pdf_export</option>
          <option value="unlimited_goals">unlimited_goals</option>
          <option value="advanced_reports">advanced_reports</option>
          <option value="ai_assistant">ai_assistant</option>
        </select>
        <button type="submit">Grant</button>
        <span class="note">Granted entitlements are <code>source=grant</code> and never expire until revoked.</span>
      </form>

      <h2>Goals</h2>
      ${table(
        ['Name', '#Target', '#Saved', 'Status'],
        user.goals.map(
          (g) => `<tr><td>${esc(g.name)}</td><td class="num">${inr(g.targetAmountPaise)}</td>
                  <td class="num">${inr(g.currentAmountPaise)}</td><td>${esc(g.status)}</td></tr>`,
        ),
      )}

      <h2>Subscriptions</h2>
      ${table(
        ['Product', 'Status', 'Renews'],
        user.subscriptions.map(
          (s) => `<tr><td><code>${esc(s.productId)}</code></td><td>${esc(s.status)}</td><td>${when(s.currentPeriodEnd)}</td></tr>`,
        ),
      )}`),
  )
})

adminRouter.post('/users/:id/entitlements', async (req, res) => {
  const featureKey = String(req.body?.featureKey ?? '')
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(featureKey)) return res.redirect(`/admin/users/${req.params.id}`)
  await db.entitlement.create({
    data: { id: uuidv7(), userId: req.params.id, featureKey, source: 'grant' },
  })
  await audit(req, 'entitlement.granted', 'entitlements', req.params.id, { featureKey })
  res.redirect(`/admin/users/${req.params.id}`)
})

adminRouter.post('/users/:id/entitlements/:eid/revoke', async (req, res) => {
  await db.entitlement.updateMany({
    where: { id: req.params.eid, userId: req.params.id },
    data: { revokedAt: new Date() },
  })
  await audit(req, 'entitlement.revoked', 'entitlements', req.params.eid, {})
  res.redirect(`/admin/users/${req.params.id}`)
})

// ── advisor rules ────────────────────────────────────────────────────────────

adminRouter.get('/rules', async (req, res) => {
  const rules = await db.advisorRule.findMany({ orderBy: [{ moduleKey: 'asc' }, { priority: 'asc' }] })
  const csrf = csrfField(req.admin!)
  res.type('html').send(
    layout('Advisor rules', '/admin/rules', `
      <h1>Advisor rules</h1>
      <p class="note">Pausing a rule stops generation immediately and expires its active recommendations
      on the next run — no deploy needed. That is what makes a badly-worded rule a five-minute incident.</p>
      ${table(
        ['Key', 'Module', 'Severity', 'Status', '#Priority', ''],
        rules.map(
          (r) => `<tr>
            <td><code>${esc(r.ruleKey)}</code><br><span class="note">${esc(r.titleTemplate)}</span></td>
            <td>${esc(r.moduleKey)}</td>
            <td>${esc(r.severity)}</td>
            <td><span class="tag ${r.status === 'active' ? 'ok' : r.status === 'paused' ? 'warn' : ''}">${esc(r.status)}</span></td>
            <td class="num">${r.priority}</td>
            <td><form class="inline" method="post" action="/admin/rules/${esc(r.id)}/toggle">
              ${csrf}<button class="${r.status === 'active' ? 'ghost' : ''}" type="submit">
                ${r.status === 'active' ? 'Pause' : 'Activate'}</button></form></td>
          </tr>`,
        ),
      )}`),
  )
})

adminRouter.post('/rules/:id/toggle', async (req, res) => {
  const rule = await db.advisorRule.findUnique({ where: { id: req.params.id }, select: { status: true, ruleKey: true } })
  if (rule) {
    const next = rule.status === 'active' ? 'paused' : 'active'
    await db.advisorRule.update({ where: { id: req.params.id }, data: { status: next } })
    await audit(req, 'advisor_rule.status_changed', 'advisor_rules', req.params.id, { from: rule.status, to: next })
  }
  res.redirect('/admin/rules')
})

// ── feature flags ────────────────────────────────────────────────────────────

adminRouter.get('/flags', async (req, res) => {
  const flags = await db.featureFlag.findMany({ orderBy: { flagKey: 'asc' } })
  const csrf = csrfField(req.admin!)
  res.type('html').send(
    layout('Feature flags', '/admin/flags', `
      <h1>Feature flags</h1>
      ${table(
        ['Key', 'Description', 'Enabled', '#Rollout', ''],
        flags.map(
          (f) => `<tr>
            <td><code>${esc(f.flagKey)}</code></td>
            <td>${esc(f.description)}</td>
            <td><span class="tag ${f.isEnabled ? 'ok' : ''}">${f.isEnabled ? 'on' : 'off'}</span></td>
            <td class="num">${f.rolloutPct}%</td>
            <td>
              <form class="inline" method="post" action="/admin/flags/${esc(f.id)}/toggle">
                ${csrf}<button class="${f.isEnabled ? 'ghost' : ''}" type="submit">${f.isEnabled ? 'Disable' : 'Enable'}</button>
              </form>
              <form class="inline" method="post" action="/admin/flags/${esc(f.id)}/rollout">
                ${csrf}<input name="pct" type="number" min="0" max="100" value="${f.rolloutPct}" style="width:78px">
                <button class="ghost" type="submit">Set %</button>
              </form>
            </td>
          </tr>`,
        ),
      )}
      <h2>Create</h2>
      <form method="post" action="/admin/flags">
        ${csrf}
        <input name="flagKey" placeholder="flag_key" required pattern="[a-z][a-z0-9_]{1,49}">
        <input name="description" placeholder="What it controls" style="min-width:280px">
        <button type="submit">Create</button>
      </form>`),
  )
})

adminRouter.post('/flags', async (req, res) => {
  const flagKey = String(req.body?.flagKey ?? '')
  if (/^[a-z][a-z0-9_]{1,49}$/.test(flagKey)) {
    await db.featureFlag.upsert({
      where: { flagKey },
      update: {},
      create: { id: uuidv7(), flagKey, description: String(req.body?.description ?? '') },
    })
    await audit(req, 'feature_flag.created', 'feature_flags', flagKey, {})
  }
  res.redirect('/admin/flags')
})

adminRouter.post('/flags/:id/toggle', async (req, res) => {
  const f = await db.featureFlag.findUnique({ where: { id: req.params.id }, select: { isEnabled: true } })
  if (f) {
    await db.featureFlag.update({ where: { id: req.params.id }, data: { isEnabled: !f.isEnabled } })
    await audit(req, 'feature_flag.toggled', 'feature_flags', req.params.id, { to: !f.isEnabled })
  }
  res.redirect('/admin/flags')
})

adminRouter.post('/flags/:id/rollout', async (req, res) => {
  const pct = Math.max(0, Math.min(100, Number(req.body?.pct ?? 0)))
  await db.featureFlag.update({ where: { id: req.params.id }, data: { rolloutPct: pct } })
  await audit(req, 'feature_flag.rollout', 'feature_flags', req.params.id, { pct })
  res.redirect('/admin/flags')
})

// ── system ───────────────────────────────────────────────────────────────────

adminRouter.get('/system', async (_req, res) => {
  const calls = await upstreamCallsToday()
  const [rates, ruleset, migrations] = await Promise.all([
    db.referenceRate.findMany({ where: { rateKind: 'fx' }, orderBy: { asOf: 'desc' }, take: 8 }),
    db.taxRuleset.findFirst({ where: { status: 'active' }, select: { fyLabel: true, rulesetKey: true, effectiveFrom: true } }),
    db.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`
      SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at`,
  ])

  const fxRaw = redisHealthy() ? await redis.get(`fx:rates:v1:${config.FX_BASE_CURRENCY}`).catch(() => null) : null
  const fx = fxRaw ? (JSON.parse(fxRaw) as { fetchedAt: string; rates: Record<string, number> }) : null
  const ageMin = fx ? Math.floor((Date.now() - Date.parse(fx.fetchedAt)) / 60000) : null

  res.type('html').send(
    layout('System', '/admin/system', `
      <h1>System</h1>
      <div class="cards">
        ${card('Redis', redisHealthy() ? '<span class="tag ok">up</span>' : '<span class="tag bad">down</span>')}
        ${card('FX cache', fx ? `<span class="tag ${ageMin! < 60 ? 'ok' : 'warn'}">${ageMin} min old</span>` : '<span class="tag warn">empty</span>',
               fx ? `${Object.keys(fx.rates).length} pairs` : 'no upstream fetch yet')}
        ${card('FX calls today', `<span class="tag ${calls > 30 ? 'bad' : 'ok'}">${calls < 0 ? 'n/a' : calls}</span>`, 'lazy refresh, ~18/day expected')}
        ${card('Tax ruleset', ruleset ? esc(ruleset.fyLabel) : '<span class="tag warn">none</span>',
               ruleset ? `<code>${esc(ruleset.rulesetKey)}</code>` : 'seed it before tax calculations')}
      </div>

      <h2>Migrations</h2>
      ${table(
        ['Migration', 'Applied'],
        migrations.map((m) => `<tr><td><code>${esc(m.migration_name)}</code></td><td>${when(m.finished_at)}</td></tr>`),
      )}

      <h2>Latest stored FX rates</h2>
      <p class="note">Written by the cache refresh so a Redis flush cannot force an upstream call.</p>
      ${table(
        ['Code', '#Rate', 'As of'],
        rates.map((r) => `<tr><td>${esc(r.code)}</td><td class="num">${r.rate.toString()}</td><td>${when(r.asOf)}</td></tr>`),
      )}`),
  )
})

// ─────────────────────────────────────────────────────────────────────────────

async function audit(
  req: Request,
  action: string,
  entityTable: string,
  entityId: string,
  after: Record<string, unknown>,
): Promise<void> {
  const admin = req.admin
  try {
    await db.auditLog.create({
      data: {
        actorType: 'admin',
        actorId: admin?.userId ?? null,
        action,
        entityTable,
        entityId: /^[0-9a-f-]{36}$/i.test(entityId) ? entityId : null,
        after: after as object,
        requestId: req.requestId,
        ipPrefix: ipPrefix(req.ip) ?? null,
      },
    })
  } catch (err) {
    logger.warn({ err, action }, 'admin.audit_failed')
  }
}
