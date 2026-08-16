/**
 * JWT_SIGNING_KEYS validation.
 *
 * Regression test for a production crash loop: JWT_SIGNING_KEYS was
 * `z.string().optional()`, so a hand-typed value passed config validation. The
 * API then logged "FinCalc API listening", bound the port, and died in
 * JSON.parse inside initSigningKeys — which `restart: unless-stopped` repeated
 * once a minute. Two separate defects: validation that did not look at the
 * value, and a listen() that happened before the keys were loaded.
 *
 * Each case runs in a SUBPROCESS because config.ts calls process.exit at import
 * time — which is the behaviour under test and cannot be observed in-process.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const BASE_ENV = {
  ...process.env,
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@h:5432/d',
  REDIS_URL: 'redis://127.0.0.1:6389',
  PASSWORD_PEPPER: '0123456789abcdef0',
  AUDIT_PEPPER: '0123456789abcdef0',
}

/** A real Ed25519 PKCS8 PEM, base64'd — the format the environment must carry. */
function validKey(): string {
  const pem = execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519'], { encoding: 'utf8' })
  return Buffer.from(pem, 'utf8').toString('base64')
}

/** Imports config.ts in a child process and reports how it went. */
function loadConfig(keys: string | undefined): { code: number | null; output: string } {
  const env = { ...BASE_ENV } as Record<string, string>
  if (keys === undefined) delete env.JWT_SIGNING_KEYS
  else env.JWT_SIGNING_KEYS = keys

  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', "import('./src/config.js').then(()=>console.log('CONFIG_OK'))"],
    { cwd: root, env, encoding: 'utf8' },
  )
  return { code: r.status, output: `${r.stdout}${r.stderr}` }
}

describe('JWT_SIGNING_KEYS validation', () => {
  test('accepts an openssl-generated Ed25519 key', () => {
    const { code, output } = loadConfig(JSON.stringify({ k1: validKey() }))
    assert.equal(code, 0, output)
    assert.match(output, /CONFIG_OK/)
  })

  test('rejects a value that is not JSON — the exact production failure', () => {
    const { code, output } = loadConfig('ugjgsjhsgdhrtjhgsahcgscnbsdjchsjkchs#gdjhg')
    assert.equal(code, 1)
    assert.match(output, /JWT_SIGNING_KEYS: is not valid JSON/)
    // The message must carry the fix, not only the fault.
    assert.match(output, /openssl genpkey -algorithm ed25519/)
  })

  test('rejects a JWK array — the shape the old docs described', () => {
    // This parses as JSON, so only a shape check catches it. DEPLOY.md and
    // .env.example both told operators to produce exactly this.
    const jwkArray = JSON.stringify([{ kid: 'k1', kty: 'OKP', crv: 'Ed25519', d: 'a', x: 'b' }])
    const { code, output } = loadConfig(jwkArray)
    assert.equal(code, 1)
    assert.match(output, /must be an OBJECT keyed by kid/)
  })

  test('rejects an empty object', () => {
    const { code, output } = loadConfig('{}')
    assert.equal(code, 1)
    assert.match(output, /no signing key/)
  })

  test('rejects base64 that is not a PKCS8 key', () => {
    // Any base64 decodes to something; only decoding and looking finds this.
    const { code, output } = loadConfig(JSON.stringify({ k1: 'aGVsbG8gd29ybGQ=' }))
    assert.equal(code, 1)
    assert.match(output, /does not decode to a PKCS8 private key/)
  })

  test('names the offending kid when several are present', () => {
    const { code, output } = loadConfig(JSON.stringify({ k1: validKey(), k2: 'bm90YWtleQ==' }))
    assert.equal(code, 1)
    assert.match(output, /key "k2"/)
  })

  test('an unset value is still refused in production', () => {
    // Unchanged behaviour, asserted so the new parsing cannot quietly make an
    // absent key acceptable: production must never run on ephemeral keys.
    const { code, output } = loadConfig(undefined)
    assert.equal(code, 1)
    assert.match(output, /cannot start in production without: JWT_SIGNING_KEYS/)
  })

  test('an empty value is treated as unset, not as malformed', () => {
    // `JWT_SIGNING_KEYS=` in a .env file yields '', which is how people say
    // "not set". It must reach the production-secrets check with that message,
    // not a JSON parse error.
    const { code, output } = loadConfig('')
    assert.equal(code, 1)
    assert.match(output, /cannot start in production without: JWT_SIGNING_KEYS/)
  })
})

describe('startup ordering', () => {
  test('a bad key never reaches "listening"', () => {
    // The original bug in one assertion: the port was bound and the success line
    // logged BEFORE the keys were parsed, so the logs claimed the API had
    // started when the process was already dying.
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/server.ts'],
      {
        cwd: root,
        env: { ...BASE_ENV, PORT: '8099', JWT_SIGNING_KEYS: 'not json' },
        encoding: 'utf8',
        timeout: 30_000,
      },
    )
    const output = `${r.stdout}${r.stderr}`
    assert.equal(r.status, 1, output)
    assert.doesNotMatch(output, /listening/i)
  })
})
