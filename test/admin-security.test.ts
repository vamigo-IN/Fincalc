/**
 * Admin panel security invariants.
 *
 * These cover the holes found when the admin creation scripts were removed and
 * the panel became the only way to change an admin password:
 *
 *   - /admin/login had NO rate limit and NO account lockout, while the mobile
 *     login path locked the same user row after 5 failures. The one account that
 *     can read every user's finances had unlimited guesses.
 *   - No CSRF token on any state-changing route. SameSite=Strict does not cover
 *     it: SameSite is scoped to the registrable domain, so www.vamigo.in and
 *     fincalc.vamigo.in are the SAME site and a form there posts here with the
 *     admin cookie attached.
 *   - Sessions were trusted for 8 hours on the Redis entry alone — removing an
 *     email from ADMIN_EMAILS or suspending the account did not end the session.
 *   - The cookie signing key fell back to config.JWT_CURRENT_KID, which is "k1".
 *
 * Pure and middleware-level checks only; they need no database. Redis is not
 * connected in this process, which is itself one of the cases under test.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { Request, Response } from 'express'

import {
  csrfField,
  requireCsrf,
  currentAdmin,
  lockoutUntil,
  readSessionId,
  setSessionCookie,
  clearSessionCookie,
  LOCKOUT_THRESHOLD,
  noStore,
  type AdminSession,
} from '../src/modules/admin/admin.security.js'

// ── test doubles ─────────────────────────────────────────────────────────────

function mockRes(): Response & { headers: Record<string, string>; statusCode: number; body: string } {
  const headers: Record<string, string> = {}
  const res = {
    headers,
    statusCode: 200,
    body: '',
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v },
    getHeader(k: string) { return headers[k.toLowerCase()] },
    status(c: number) { res.statusCode = c; return res },
    type() { return res },
    send(b: string) { res.body = b; return res },
  }
  return res as unknown as Response & { headers: Record<string, string>; statusCode: number; body: string }
}

function mockReq(opts: {
  cookie?: string
  method?: string
  body?: Record<string, unknown>
  admin?: AdminSession
} = {}): Request {
  return {
    method: opts.method ?? 'POST',
    path: '/admin/flags',
    ip: '203.0.113.9',
    body: opts.body ?? {},
    admin: opts.admin,
    header: (name: string) => (name.toLowerCase() === 'cookie' ? opts.cookie : undefined),
  } as unknown as Request
}

const session = (over: Partial<AdminSession> = {}): AdminSession => ({
  sid: '11111111-2222-3333-4444-555555555555',
  userId: '66666666-7777-8888-9999-000000000000',
  email: 'admin@vamigo.in',
  createdAt: Math.floor(Date.now() / 1000),
  csrf: 'a-token-that-is-long-enough-to-be-real',
  ...over,
})

// ── CSRF ─────────────────────────────────────────────────────────────────────

describe('admin CSRF', () => {
  test('a POST with the correct token passes', () => {
    const s = session()
    let called = false
    requireCsrf(mockReq({ admin: s, body: { _csrf: s.csrf } }), mockRes(), () => { called = true })
    assert.equal(called, true)
  })

  test('a POST with NO token is rejected with 403', () => {
    // The cross-site case: an attacker's form cannot read the token, so this is
    // exactly what a CSRF attempt looks like on the wire.
    const res = mockRes()
    let called = false
    requireCsrf(mockReq({ admin: session(), body: {} }), res, () => { called = true })
    assert.equal(called, false)
    assert.equal(res.statusCode, 403)
  })

  test('a POST with a WRONG token is rejected', () => {
    const res = mockRes()
    let called = false
    requireCsrf(
      mockReq({ admin: session(), body: { _csrf: 'a-token-that-is-long-enough-to-be-fake' } }),
      res,
      () => { called = true },
    )
    assert.equal(called, false)
    assert.equal(res.statusCode, 403)
  })

  test('a token from a DIFFERENT session is rejected', () => {
    // Per-session secrets: holding a valid token for your own session must not
    // authorise an action in someone else's.
    const res = mockRes()
    let called = false
    requireCsrf(
      mockReq({ admin: session(), body: { _csrf: session({ csrf: 'other-session-token-value-here' }).csrf } }),
      res,
      () => { called = true },
    )
    assert.equal(called, false)
    assert.equal(res.statusCode, 403)
  })

  test('GET is not blocked', () => {
    let called = false
    requireCsrf(mockReq({ method: 'GET', admin: session() }), mockRes(), () => { called = true })
    assert.equal(called, true)
  })

  test('the rendered field carries the session token', () => {
    const s = session()
    const html = csrfField(s)
    assert.match(html, /name="_csrf"/)
    assert.ok(html.includes(s.csrf))
  })
})

// ── cookies ──────────────────────────────────────────────────────────────────

describe('admin session cookie', () => {
  test('a cookie this process signed round-trips', () => {
    const res = mockRes()
    const sid = '11111111-2222-3333-4444-555555555555'
    setSessionCookie(res, sid)
    const header = res.headers['set-cookie']!
    const value = header.split(';')[0]!.split('=').slice(1).join('=')
    assert.equal(readSessionId(mockReq({ cookie: `fincalc_admin=${value}` })), sid)
  })

  test('a tampered session id is rejected', () => {
    // The signature is what stops an attacker naming their own session id.
    const res = mockRes()
    setSessionCookie(res, '11111111-2222-3333-4444-555555555555')
    const sig = res.headers['set-cookie']!.split(';')[0]!.split('.')[1]
    assert.equal(readSessionId(mockReq({ cookie: `fincalc_admin=99999999-9999-9999-9999-999999999999.${sig}` })), null)
  })

  test('an unsigned cookie is rejected', () => {
    assert.equal(readSessionId(mockReq({ cookie: 'fincalc_admin=11111111-2222-3333-4444-555555555555' })), null)
  })

  test('no cookie yields null', () => {
    assert.equal(readSessionId(mockReq()), null)
  })

  test('the cookie is HttpOnly, SameSite=Strict and scoped to /admin', () => {
    const res = mockRes()
    setSessionCookie(res, 'abc')
    const c = res.headers['set-cookie']!
    assert.match(c, /HttpOnly/)
    assert.match(c, /SameSite=Strict/)
    assert.match(c, /Path=\/admin/)
  })

  test('clearing expires the cookie immediately', () => {
    const res = mockRes()
    clearSessionCookie(res)
    assert.match(res.headers['set-cookie']!, /Max-Age=0/)
  })
})

// ── sessions fail closed ─────────────────────────────────────────────────────

describe('admin session validation', () => {
  test('no session when Redis is unavailable', async () => {
    // Redis is not connected in this test process. Failing CLOSED is the point:
    // without the session store there is no way to know a session was revoked.
    const res = mockRes()
    setSessionCookie(res, '11111111-2222-3333-4444-555555555555')
    const value = res.headers['set-cookie']!.split(';')[0]!.split('=').slice(1).join('=')
    assert.equal(await currentAdmin(mockReq({ cookie: `fincalc_admin=${value}` })), null)
  })
})

// ── lockout ──────────────────────────────────────────────────────────────────

describe('admin login lockout', () => {
  test('no lock below the threshold', () => {
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) assert.equal(lockoutUntil(i), null)
  })

  test('locks at the threshold and escalates, capped at 15 minutes', () => {
    const at = (n: number) => (lockoutUntil(n)!.getTime() - Date.now()) / 60_000
    assert.ok(Math.abs(at(LOCKOUT_THRESHOLD) - 1) < 0.05, 'first lock is ~1 minute')
    assert.ok(Math.abs(at(LOCKOUT_THRESHOLD + 4) - 5) < 0.05, 'escalates with each failure')
    // Uncapped, 100 failures would lock for 96 minutes; the cap keeps a
    // forgotten password from becoming an unbounded self-inflicted outage.
    assert.ok(Math.abs(at(100) - 15) < 0.05, 'capped at 15 minutes')
  })
})

// ── response headers ─────────────────────────────────────────────────────────

describe('admin response hardening', () => {
  test('admin pages are never stored', () => {
    // These pages render other people's financial data; a shared proxy or the
    // back-forward cache must not retain them after sign-out.
    const res = mockRes()
    noStore(mockReq(), res, () => {})
    assert.match(res.headers['cache-control']!, /no-store/)
    assert.equal(res.headers['referrer-policy'], 'no-referrer')
  })
})
