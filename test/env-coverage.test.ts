/**
 * Keeps .env.example, docker-compose.yml and src/config.ts in agreement.
 *
 * They had drifted in both directions at once, silently:
 *
 *   - Eight real tunables (ACCESS_TOKEN_TTL_S, BODY_LIMIT, FX_*, …) were in
 *     .env.example and in the config schema but absent from the compose
 *     environment. Setting them did NOTHING in a container. The file advertised
 *     knobs that were not connected to anything.
 *   - Twelve sizing variables (PG_*, API_*, REDIS_*) were used by compose but
 *     undocumented, so the only way to discover them was to read the YAML.
 *
 * Nothing fails loudly when this happens — the value just stays at its default
 * while the operator believes they changed it. Hence a test.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f: string): string => readFileSync(resolve(root, f), 'utf8')

const envExample = read('.env.example')
const compose = read('docker-compose.yml')
const configSrc = read('src/config.ts')

/** Field names in the Zod schema — two-space indented `NAME:` entries. */
const schemaKeys = new Set(
  [...configSrc.matchAll(/^ {2}([A-Z_][A-Z0-9_]*):/gm)].map((m) => m[1]!),
)

/**
 * Keys compose substitutes from the environment: `${NAME` …
 *
 * Comment lines are stripped first: the file explains the `${VAR:-}` convention
 * in prose, and a naive scan reads that example as a variable named VAR.
 */
const composeYaml = compose
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n')

const composeKeys = new Set(
  [...composeYaml.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]!),
)

/** Documented in .env.example, whether set (`NAME=`) or shown (`#NAME=`). */
const documentedKeys = new Set(
  [...envExample.matchAll(/^#?([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]!),
)

/**
 * Derived by compose from the service names and POSTGRES_PASSWORD, and pinned
 * rather than passed through. NODE_ENV especially: making it overridable is how
 * the VPS ended up running development settings in production.
 */
const PINNED_BY_COMPOSE = new Set(['NODE_ENV', 'DATABASE_URL', 'REDIS_URL', 'PORT'])

describe('env documentation coverage', () => {
  test('every config field is documented in .env.example', () => {
    const missing = [...schemaKeys].filter((k) => !documentedKeys.has(k)).sort()
    assert.deepEqual(missing, [], `undocumented config fields: ${missing.join(', ')}`)
  })

  test('every compose variable is documented in .env.example', () => {
    // This is how PG_CPUS, API_MEMORY and the other ten sizing knobs were
    // discoverable only by reading the YAML.
    const missing = [...composeKeys].filter((k) => !documentedKeys.has(k)).sort()
    assert.deepEqual(missing, [], `compose vars absent from .env.example: ${missing.join(', ')}`)
  })

  test('every app config field actually reaches the container', () => {
    // The original defect: a field in the schema and in .env.example but not in
    // the compose environment is a setting the container never receives, and
    // nothing reports that.
    const unreachable = [...schemaKeys]
      .filter((k) => !PINNED_BY_COMPOSE.has(k))
      .filter((k) => !composeKeys.has(k))
      .sort()
    assert.deepEqual(
      unreachable,
      [],
      `settable in .env but never passed to the container: ${unreachable.join(', ')}`,
    )
  })

  test('pinned values are hardcoded, not substitutable', () => {
    // NODE_ENV: production must not be reachable from .env. If it becomes
    // ${NODE_ENV:-production}, a stray line disables fail-fast on the live box.
    for (const k of PINNED_BY_COMPOSE) {
      assert.ok(
        !composeKeys.has(k),
        `${k} must stay hardcoded in docker-compose.yml, not read from .env`,
      )
    }
  })

  test('optional compose passthroughs do not restate config defaults', () => {
    // A default written in both places drifts, and then the running value stops
    // matching the documented one. config.ts is the single source.
    const withDefaults = [...composeYaml.matchAll(/\$\{([A-Z_][A-Z0-9_]*):-([^}]+)\}/g)]
      .map((m) => ({ key: m[1]!, value: m[2]! }))
      // POSTGRES_PASSWORD is not a config field; its dev fallback belongs here
      // because Postgres itself needs it, not the app schema.
      .filter(({ key }) => schemaKeys.has(key))
      .map(({ key, value }) => `${key}=${value}`)
    assert.deepEqual(
      withDefaults,
      [],
      `these restate a config.ts default in compose; use \${VAR:-}: ${withDefaults.join(', ')}`,
    )
  })

  test('the four required secrets are present and unset in .env.example', () => {
    // Shipping a value for any of these is how a default secret reaches
    // production. They must be listed, and listed empty.
    for (const k of ['POSTGRES_PASSWORD', 'PASSWORD_PEPPER', 'AUDIT_PEPPER', 'JWT_SIGNING_KEYS']) {
      assert.match(envExample, new RegExp(`^${k}=$`, 'm'), `${k} must be present and empty`)
    }
  })
})
