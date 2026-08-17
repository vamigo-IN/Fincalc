/**
 * Feed token format.
 *
 * The StockVirtue feed verifies
 *     sv1.<clientId>.<expSeconds>.<base64url HMAC-SHA256 of the first three>
 * and refuses anything else with a bare `unauthorized` that says nothing about
 * why. So a format mistake here does not surface as a readable error — it
 * surfaces as a ticker that never populates, which is indistinguishable from
 * being offline.
 *
 * These tests pin the exact bytes, and verify the signature independently of
 * the code that produced it.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

import {
  mintFeedToken,
  verifyFeedToken,
  assertValidClientId,
  TOKEN_VERSION,
} from '../src/modules/market/feed-token.js'

const SECRET = 'a-test-secret-at-least-16-chars'
const CLIENT = 'fincalc-app'
// Fixed clock so expiry maths is checked against a known number rather than
// against itself.
const NOW = 1_786_930_000_000 // ms

describe('feed token format', () => {
  test('has exactly four dot-separated parts', () => {
    const { token } = mintFeedToken(CLIENT, SECRET, 900, NOW)
    assert.equal(token.split('.').length, 4)
  })

  test('the first three parts are version, client id and expiry', () => {
    const { token } = mintFeedToken(CLIENT, SECRET, 900, NOW)
    const [version, clientId, exp] = token.split('.')
    assert.equal(version, TOKEN_VERSION)
    assert.equal(version, 'sv1')
    assert.equal(clientId, CLIENT)
    assert.equal(exp, String(Math.floor(NOW / 1000) + 900))
  })

  test('expiry is in SECONDS, not milliseconds', () => {
    // The bug this exists for: passing Date.now() through unchanged mints a
    // token that expires in the year 58000. A server comparing exp against the
    // clock accepts it, so the token is silently permanent.
    const { expiresAt } = mintFeedToken(CLIENT, SECRET, 900, NOW)
    assert.equal(expiresAt, 1_786_930_900)
    assert.ok(expiresAt < 4_000_000_000, 'looks like milliseconds')
  })

  test('the signature is base64url over the first three parts', () => {
    // Computed here independently — if mint and verify shared a bug, a
    // round-trip test alone would still pass.
    const { token } = mintFeedToken(CLIENT, SECRET, 900, NOW)
    const parts = token.split('.')
    const body = parts.slice(0, 3).join('.')
    const expected = createHmac('sha256', SECRET).update(body).digest('base64url')

    assert.equal(parts[3], expected)
    // base64url, not base64: no +, / or = anywhere.
    assert.doesNotMatch(parts[3]!, /[+/=]/)
  })

  test('a minted token verifies', () => {
    const { token } = mintFeedToken(CLIENT, SECRET, 900, NOW)
    const r = verifyFeedToken(token, SECRET, NOW)
    assert.equal(r.valid, true, r.reason)
    assert.equal(r.clientId, CLIENT)
  })
})

describe('feed token rejection', () => {
  test('a different secret does not verify', () => {
    const { token } = mintFeedToken(CLIENT, SECRET, 900, NOW)
    const r = verifyFeedToken(token, 'a-different-secret-16-chars', NOW)
    assert.equal(r.valid, false)
    assert.equal(r.reason, 'signature')
  })

  test('a tampered client id does not verify', () => {
    // The attack the signature exists to stop: claiming to be another consumer.
    const { token } = mintFeedToken(CLIENT, SECRET, 900, NOW)
    const parts = token.split('.')
    parts[1] = 'someone-else'
    const r = verifyFeedToken(parts.join('.'), SECRET, NOW)
    assert.equal(r.valid, false)
    assert.equal(r.reason, 'signature')
  })

  test('an extended expiry does not verify', () => {
    const { token } = mintFeedToken(CLIENT, SECRET, 900, NOW)
    const parts = token.split('.')
    parts[2] = String(Number(parts[2]) + 86_400)
    const r = verifyFeedToken(parts.join('.'), SECRET, NOW)
    assert.equal(r.valid, false)
    assert.equal(r.reason, 'signature')
  })

  test('an expired but correctly signed token is reported as expired', () => {
    const { token } = mintFeedToken(CLIENT, SECRET, 900, NOW)
    const r = verifyFeedToken(token, SECRET, NOW + 901_000)
    assert.equal(r.valid, false)
    assert.equal(r.reason, 'expired')
  })

  test('a forged expired token reads as forged, not merely stale', () => {
    // Signature is checked before expiry so the reason is the real one.
    const { token } = mintFeedToken(CLIENT, SECRET, 900, NOW)
    const parts = token.split('.')
    parts[3] = 'not-a-real-signature'
    const r = verifyFeedToken(parts.join('.'), SECRET, NOW + 901_000)
    assert.equal(r.valid, false)
    assert.equal(r.reason, 'signature')
  })

  test('malformed input is rejected, not thrown on', () => {
    for (const bad of ['', 'nonsense', 'sv1.a.b', 'sv1.a.b.c.d', 'sv2.x.1.y']) {
      const r = verifyFeedToken(bad, SECRET, NOW)
      assert.equal(r.valid, false, `accepted: ${bad}`)
    }
  })
})

describe('client id validation', () => {
  test('a dot in the client id is refused at mint time', () => {
    // A dot is the field separator, so "fincalc.app" shifts every position and
    // the feed reads a different id — or fails to parse. It would look like an
    // auth problem, from a value nobody suspects.
    assert.throws(() => assertValidClientId('fincalc.app'), /must not contain/)
    assert.throws(() => mintFeedToken('fincalc.app', SECRET, 900, NOW), /must not contain/)
  })

  test('an empty client id or secret is refused', () => {
    assert.throws(() => mintFeedToken('', SECRET, 900, NOW), /empty/)
    assert.throws(() => mintFeedToken(CLIENT, '', 900, NOW), /empty/)
  })

  test('the documented default client id is valid', () => {
    assert.doesNotThrow(() => assertValidClientId('fincalc-app'))
  })
})
