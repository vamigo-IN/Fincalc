/**
 * Password hashing and token signing — docs/fincalc-2.0/10 §3–4.
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import bcrypt from 'bcryptjs'
import {
  SignJWT,
  jwtVerify,
  importPKCS8,
  exportPKCS8,
  exportJWK,
  importJWK,
  generateKeyPair,
  type CryptoKey,
} from 'jose'
import { config } from '../../config.js'
import { logger } from '../../obs/logger.js'
import { AppError } from '../../errors.js'

// ── passwords ────────────────────────────────────────────────────────────────

/**
 * Pepper first, then bcrypt. The pepper lives in the environment and never in
 * the database, so the far more common breach — a stolen backup or a
 * misconfigured replica — yields hashes that cannot be cracked without also
 * compromising the host.
 */
function pepper(password: string): string {
  const p = config.PASSWORD_PEPPER
  if (!p) return password // dev only; production boot already refused without it
  return createHmac('sha256', p).update(password).digest('base64')
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(pepper(password), config.BCRYPT_COST)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(pepper(password), hash)
  } catch {
    return false
  }
}

/**
 * Spend the same time as a real verification, for a login attempt against an
 * account that does not exist.
 *
 * Returning early when no user matches is an oracle: a real admin email costs
 * ~155ms in bcrypt while an unknown one answers instantly, which tells an
 * attacker which address to start guessing against.
 *
 * The hash is GENERATED at first use rather than written as a literal. A
 * hand-written constant that bcrypt considers malformed makes `compare` fail
 * immediately — the fast path this exists to avoid, and it would have looked
 * correct in review.
 */
let dummyHash: Promise<string> | null = null

export async function burnPasswordVerification(password: string): Promise<void> {
  dummyHash ??= bcrypt.hash(pepper(randomBytes(32).toString('base64')), config.BCRYPT_COST)
  try {
    await bcrypt.compare(pepper(password), await dummyHash)
  } catch {
    /* the result is deliberately discarded; only the elapsed time matters */
  }
}

/** The 100 most common passwords are worth more than any composition rule. */
const COMMON = new Set([
  'password', '12345678', '123456789', 'qwerty123', 'password1', '1234567890',
  'iloveyou', 'admin123', 'welcome1', 'password123', 'abc123456', 'qwertyuiop',
  'india@123', 'india123', 'letmein1', 'football1', 'monkey12', 'sunshine1',
])

export function assertPasswordAcceptable(password: string): void {
  const errs: string[] = []
  if (password.length < 10) errs.push('password must be at least 10 characters')
  if (password.length > 200) errs.push('password must be at most 200 characters')
  if (COMMON.has(password.toLowerCase())) errs.push('that password is too common')
  if (errs.length) throw new AppError('WEAK_PASSWORD', { details: errs })
}

// ── opaque tokens ────────────────────────────────────────────────────────────

/**
 * Prisma's `Bytes` is `Uint8Array<ArrayBuffer>`, while Node's `Buffer` is
 * `Uint8Array<ArrayBufferLike>` (it may sit on a SharedArrayBuffer). They are not
 * assignable, so every digest is copied into a plain Uint8Array at this boundary
 * rather than casting at each call site.
 */
export type Bytes = Uint8Array<ArrayBuffer>

function toBytes(b: Buffer): Bytes {
  const out = new Uint8Array(new ArrayBuffer(b.length))
  out.set(b)
  return out
}

/** Refresh tokens are opaque random bytes; only their SHA-256 is stored. */
export function newOpaqueToken(): { raw: string; hash: Bytes } {
  const bytes = randomBytes(32)
  return { raw: bytes.toString('base64url'), hash: sha256(bytes) }
}

export function sha256(input: Buffer | string): Bytes {
  return toBytes(createHash('sha256').update(input).digest())
}

export function hashOpaqueToken(raw: string): Bytes {
  return sha256(Buffer.from(raw, 'base64url'))
}

export function safeEqual(a: Bytes, b: Bytes): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Correlatable after DPDP erasure, but not reversible to a person (docs 05 §4.16). */
export function subjectHash(userId: string): Bytes | null {
  if (!config.AUDIT_PEPPER) return null
  return toBytes(createHmac('sha256', config.AUDIT_PEPPER).update(userId).digest())
}

// ── JWT (EdDSA / Ed25519) ────────────────────────────────────────────────────

interface KeyEntry {
  kid: string
  privateKey: CryptoKey
  publicKey: CryptoKey
}

const keys = new Map<string, KeyEntry>()
let currentKid = config.JWT_CURRENT_KID

/**
 * An Ed25519 private JWK already carries the public component in `x`; dropping
 * `d` yields the public key. Generating a fresh pair here instead would produce
 * a public key unrelated to the signing key, and every verification would fail.
 */
async function derivePublicKey(privateKey: CryptoKey): Promise<CryptoKey> {
  const jwk = await exportJWK(privateKey)
  delete jwk.d
  jwk.key_ops = ['verify']
  return (await importJWK(jwk, 'EdDSA')) as CryptoKey
}

/**
 * EdDSA over HS256: with a shared symmetric secret, anything that can VERIFY can
 * also MINT. Today only the API verifies, but the worker and a future web BFF
 * will too, and at that point a shared secret is a mint-anywhere key.
 */
export async function initSigningKeys(): Promise<void> {
  if (config.JWT_SIGNING_KEYS) {
    // Already parsed and shape-checked in config.ts, so this cannot throw on a
    // malformed value. It used to JSON.parse here — after the port was open.
    for (const [kid, pkcs8b64] of Object.entries(config.JWT_SIGNING_KEYS)) {
      const pem = Buffer.from(pkcs8b64, 'base64').toString('utf8')
      const privateKey = (await importPKCS8(pem, 'EdDSA', { extractable: true })) as CryptoKey
      keys.set(kid, { kid, privateKey, publicKey: await derivePublicKey(privateKey) })
    }
    if (!keys.has(currentKid)) currentKid = [...keys.keys()][0] ?? currentKid
    logger.info({ kids: [...keys.keys()], currentKid }, 'jwt.keys_loaded')
    return
  }

  // Development only: an ephemeral pair, regenerated on every boot. Every
  // existing session is invalidated by a restart — which is exactly why
  // production refuses to start without JWT_SIGNING_KEYS.
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })
  keys.set(currentKid, {
    kid: currentKid,
    privateKey: privateKey as CryptoKey,
    publicKey: publicKey as CryptoKey,
  })
  logger.warn(
    { kid: currentKid },
    'jwt.ephemeral_key — JWT_SIGNING_KEYS unset; tokens will not survive a restart. Development only.',
  )
}

/** Helper for generating a key to paste into JWT_SIGNING_KEYS. */
export async function generateSigningKeyBase64(): Promise<string> {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })
  const pem = await exportPKCS8(privateKey as CryptoKey)
  return Buffer.from(pem, 'utf8').toString('base64')
}

export interface AccessClaims {
  sub: string
  sid: string
  did?: string
  ent: string[]
  adm: boolean
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  const entry = keys.get(currentKid)
  if (!entry) throw new AppError('INTERNAL_ERROR', { context: { reason: 'no signing key' } })

  return new SignJWT({ sid: claims.sid, did: claims.did, ent: claims.ent, adm: claims.adm })
    .setProtectedHeader({ alg: 'EdDSA', kid: entry.kid })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_S}s`)
    .setJti(crypto.randomUUID())
    .sign(entry.privateKey)
}

export async function verifyAccessToken(token: string): Promise<AccessClaims & { jti: string }> {
  const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as {
    kid?: string
  }
  const entry = keys.get(header.kid ?? currentKid)
  if (!entry) throw new AppError('UNAUTHENTICATED', { context: { reason: 'unknown kid' } })

  try {
    const { payload } = await jwtVerify(token, entry.publicKey, {
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    })
    return {
      sub: String(payload.sub),
      sid: String(payload.sid),
      did: payload.did ? String(payload.did) : undefined,
      ent: Array.isArray(payload.ent) ? (payload.ent as string[]) : [],
      adm: payload.adm === true,
      jti: String(payload.jti),
    }
  } catch (err) {
    const expired = err instanceof Error && err.name === 'JWTExpired'
    throw new AppError(expired ? 'ACCESS_TOKEN_EXPIRED' : 'UNAUTHENTICATED', { cause: err })
  }
}
