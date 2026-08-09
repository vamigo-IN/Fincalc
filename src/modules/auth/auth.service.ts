import { uuidv7 } from 'uuidv7'
import { unsafeSystemClient as db } from '../../db/prisma.js'
import { AppError } from '../../errors.js'
import { config } from '../../config.js'
import { logger } from '../../obs/logger.js'
import {
  assertPasswordAcceptable,
  hashOpaqueToken,
  hashPassword,
  newOpaqueToken,
  signAccessToken,
  subjectHash,
  verifyPassword,
} from './crypto.js'

export interface RequestCtx {
  ipPrefix?: string | undefined
  userAgent?: string | undefined
  deviceId?: string | undefined
  platform?: 'android' | 'ios' | 'web' | undefined
}

export interface TokenPair {
  accessToken: string
  expiresIn: number
  refreshToken: string
  refreshExpiresIn: number
}

async function audit(
  event: string,
  outcome: 'ok' | 'denied' | 'error',
  ctx: RequestCtx,
  opts: { userId?: string; emailAttempted?: string; detail?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await db.authAuditLog.create({
      data: {
        userId: opts.userId ?? null,
        subjectHash: opts.userId ? subjectHash(opts.userId) : null,
        emailAttempted: opts.emailAttempted ?? null,
        event,
        outcome,
        deviceId: ctx.deviceId ?? null,
        ipPrefix: ctx.ipPrefix ?? null,
        userAgent: ctx.userAgent ?? null,
        detail: (opts.detail ?? {}) as object,
      },
    })
  } catch (err) {
    logger.warn({ err, event }, 'audit.write_failed')
  }
}

type Db = typeof db | Parameters<Parameters<typeof db.$transaction>[0]>[0]

async function entitlementsFor(userId: string, client: Db = db): Promise<string[]> {
  const rows = await client.entitlement.findMany({
    where: {
      userId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { featureKey: true },
  })
  return rows.map((r) => r.featureKey)
}

async function upsertDevice(userId: string, ctx: RequestCtx, client: Db = db): Promise<string | null> {
  if (!ctx.deviceId) return null
  const device = await client.userDevice.upsert({
    where: { userId_deviceId: { userId, deviceId: ctx.deviceId } },
    update: { lastSeenAt: new Date(), revokedAt: null },
    create: {
      id: uuidv7(),
      userId,
      deviceId: ctx.deviceId,
      platform: ctx.platform ?? 'android',
    },
    select: { id: true },
  })
  return device.id
}

async function issueTokens(
  userId: string,
  familyId: string,
  deviceRowId: string | null,
  ctx: RequestCtx,
  parentId?: string,
  client: Db = db,
): Promise<TokenPair> {
  const { raw, hash } = newOpaqueToken()
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_S * 1000)

  await client.refreshToken.create({
    data: {
      id: uuidv7(),
      userId,
      deviceId: deviceRowId,
      tokenHash: hash,
      familyId,
      parentId: parentId ?? null,
      expiresAt,
      ipPrefix: ctx.ipPrefix ?? null,
      userAgent: ctx.userAgent ?? null,
    },
  })

  const user = await client.user.findUnique({ where: { id: userId }, select: { email: true } })
  const accessToken = await signAccessToken({
    sub: userId,
    sid: familyId,
    did: ctx.deviceId,
    ent: await entitlementsFor(userId, client),
    adm: user ? config.adminEmails.has(user.email.toLowerCase()) : false,
  })

  return {
    accessToken,
    expiresIn: config.ACCESS_TOKEN_TTL_S,
    refreshToken: raw,
    refreshExpiresIn: config.REFRESH_TOKEN_TTL_S,
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export async function register(
  input: { email: string; password: string; displayName?: string },
  ctx: RequestCtx,
): Promise<{ userId: string; email: string; tokens: TokenPair }> {
  assertPasswordAcceptable(input.password)

  const existing = await db.user.findFirst({
    where: { email: input.email, deletedAt: null },
    select: { id: true },
  })
  if (existing) {
    await audit('register.duplicate', 'denied', ctx, { emailAttempted: input.email })
    // Deliberate, bounded enumeration (docs 07 §3.1): a signup form that silently
    // succeeds on a taken address is a support nightmare. The `auth` rate bucket
    // stops this being an enumeration oracle.
    throw new AppError('EMAIL_ALREADY_REGISTERED')
  }

  const userId = uuidv7()
  const passwordHash = await hashPassword(input.password) // outside the tx: ~155ms of CPU

  // ONE transaction. Creating the user and then issuing tokens separately means a
  // failure between them leaves a half-registered account that can never sign up
  // again (it exists) and was never signed in (it has no tokens).
  const tokens = await db.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email: input.email, passwordHash } })
    await tx.userProfile.create({ data: { id: uuidv7(), userId, displayName: input.displayName ?? null } })
    await tx.syncState.create({ data: { userId } })
    const deviceRowId = await upsertDevice(userId, ctx, tx)
    return issueTokens(userId, uuidv7(), deviceRowId, ctx, undefined, tx)
  })

  await audit('register.success', 'ok', ctx, { userId })

  return { userId, email: input.email, tokens }
}

export async function login(
  input: { email: string; password: string },
  ctx: RequestCtx,
): Promise<{ userId: string; tokens: TokenPair }> {
  const user = await db.user.findFirst({
    where: { email: input.email, deletedAt: null },
    select: { id: true, passwordHash: true, status: true, lockedUntil: true, failedLoginCount: true },
  })

  if (!user) {
    // Hash anyway so a missing account and a wrong password take the same time.
    await hashPassword(input.password)
    await audit('login.failed', 'denied', ctx, { emailAttempted: input.email, detail: { reason: 'no_user' } })
    throw new AppError('UNAUTHENTICATED')
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit('login.locked', 'denied', ctx, { userId: user.id })
    throw new AppError('ACCOUNT_LOCKED')
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    const failed = user.failedLoginCount + 1
    await db.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failed,
        // Exponential-ish lockout after 5 failures; capped so a determined
        // attacker cannot lock a real user out permanently.
        lockedUntil: failed >= 5 ? new Date(Date.now() + Math.min(failed - 4, 15) * 60_000) : null,
      },
    })
    await audit('login.failed', 'denied', ctx, { userId: user.id, detail: { failed } })
    throw new AppError('UNAUTHENTICATED')
  }

  if (user.status !== 'active') {
    await audit('login.inactive', 'denied', ctx, { userId: user.id })
    throw new AppError('FORBIDDEN')
  }

  await db.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  })

  const deviceRowId = await upsertDevice(user.id, ctx)
  const tokens = await issueTokens(user.id, uuidv7(), deviceRowId, ctx)
  await audit('login.success', 'ok', ctx, { userId: user.id })

  return { userId: user.id, tokens }
}

/**
 * Rotation with reuse detection — docs/fincalc-2.0/10 §3.2–3.3.
 *
 * Rotation alone does not stop a stolen refresh token; what it buys is
 * DETECTABILITY. The legitimate device still holds the old token, so the next
 * time it refreshes it presents one already marked used. That is the signal.
 * Killing the whole family logs out both the thief and the victim; the victim
 * re-authenticates with their password, the thief cannot.
 */
export async function refresh(rawToken: string, ctx: RequestCtx): Promise<TokenPair> {
  const hash = hashOpaqueToken(rawToken)

  const row = await db.refreshToken.findUnique({
    where: { tokenHash: hash },
    select: {
      id: true, userId: true, deviceId: true, familyId: true,
      usedAt: true, revokedAt: true, expiresAt: true,
    },
  })

  if (!row) {
    await audit('refresh.invalid', 'denied', ctx)
    throw new AppError('REFRESH_TOKEN_INVALID')
  }
  if (row.revokedAt) {
    await audit('refresh.revoked', 'denied', ctx, { userId: row.userId })
    throw new AppError('REFRESH_TOKEN_REVOKED')
  }
  if (row.expiresAt < new Date()) {
    await audit('refresh.expired', 'denied', ctx, { userId: row.userId })
    throw new AppError('REFRESH_TOKEN_EXPIRED')
  }

  if (row.usedAt) {
    // REUSE. Either the token was stolen and the thief is using it, or it was
    // stolen and the victim is. We cannot tell which, so end the whole lineage.
    await db.refreshToken.updateMany({
      where: { familyId: row.familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'reuse_detected' },
    })
    await audit('refresh.reuse_detected', 'denied', ctx, {
      userId: row.userId,
      detail: { familyId: row.familyId, presentedTokenId: row.id },
    })
    logger.error({ userId: row.userId, familyId: row.familyId }, 'auth.refresh_reuse_detected')
    throw new AppError('REFRESH_TOKEN_REUSED')
  }

  // Mark used and mint the successor in ONE transaction: a crash between the two
  // must not leave a token that is both valid and already exchanged.
  return db.$transaction(async () => {
    await db.refreshToken.update({ where: { id: row.id }, data: { usedAt: new Date() } })
    const pair = await issueTokens(row.userId, row.familyId, row.deviceId, ctx, row.id)
    await audit('refresh.success', 'ok', ctx, { userId: row.userId })
    return pair
  })
}

export async function logout(rawToken: string, ctx: RequestCtx): Promise<void> {
  const hash = hashOpaqueToken(rawToken)
  const row = await db.refreshToken.findUnique({ where: { tokenHash: hash }, select: { familyId: true, userId: true } })
  if (!row) return // idempotent
  await db.refreshToken.updateMany({
    where: { familyId: row.familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'logout' },
  })
  await audit('logout', 'ok', ctx, { userId: row.userId })
}

export async function logoutAll(userId: string, ctx: RequestCtx): Promise<number> {
  const res = await db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'logout_all' },
  })
  await audit('logout_all', 'ok', ctx, { userId, detail: { revoked: res.count } })
  return res.count
}

export async function me(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, emailVerifiedAt: true, createdAt: true,
      profile: {
        select: {
          displayName: true, city: true, stateCode: true, isMetroForHra: true,
          dependants: true, currencyCode: true, onboardingCompletedAt: true,
        },
      },
    },
  })
  if (!user) throw new AppError('NOT_FOUND')

  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt,
    profile: user.profile,
    entitlements: await entitlementsFor(userId),
    isAdmin: config.adminEmails.has(user.email.toLowerCase()),
  }
}
