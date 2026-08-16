/**
 * Reset the admin account's password.
 *
 *   npx tsx scripts/reset-admin.ts                 # generates one, prints it once
 *   ADMIN_PASSWORD='...' npx tsx scripts/reset-admin.ts
 *
 * Exists because the seed is deliberately idempotent — it will not touch an
 * existing admin's password, so a deploy can never silently reset the account
 * that can read every user's financial data. That leaves one real situation
 * uncovered: the password is lost. This is that escape hatch, and it is a
 * deliberate manual step rather than something a deploy does.
 *
 * It also VERIFIES the account. An admin seeded before email verification
 * existed cannot sign in and cannot verify itself, which is exactly the state
 * this database was in.
 */
import { randomBytes } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { config } from '../src/config.js'
import { hashPassword } from '../src/modules/auth/crypto.js'

const db = new PrismaClient()

async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase() ?? [...config.adminEmails][0]

  if (!email) {
    throw new Error('No admin email. Set ADMIN_EMAILS in .env, or pass ADMIN_EMAIL.')
  }
  if (!config.adminEmails.has(email)) {
    // Resetting a password for an account that is not on the allowlist would
    // produce working credentials that still cannot reach the dashboard.
    throw new Error(
      `${email} is not in ADMIN_EMAILS, so it would not have admin access. ` +
        `Current allowlist: ${[...config.adminEmails].join(', ') || '(empty)'}`,
    )
  }

  const supplied = process.env.ADMIN_PASSWORD?.trim()
  const password = supplied ?? randomBytes(18).toString('base64url')

  if (password.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters.')
  }

  const user = await db.user.findFirst({ where: { email }, select: { id: true } })
  const passwordHash = await hashPassword(password)

  if (user) {
    await db.$transaction([
      db.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          // Bumping this is what invalidates existing sessions: any access token
          // issued before now is rejected. A password reset that left old
          // sessions alive would not actually lock anyone out.
          passwordChangedAt: new Date(),
          emailVerifiedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
          status: 'active',
        },
      }),
      // Revoke refresh tokens for the same reason.
      db.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ])
    console.log(`admin ${email} — password reset, account verified, sessions revoked`)
  } else {
    const created = await db.user.create({
      data: {
        email,
        passwordHash,
        emailVerifiedAt: new Date(),
        profile: { create: {} },
        syncState: { create: {} },
      },
      select: { id: true },
    })
    console.log(`admin ${email} created (${created.id})`)
  }

  if (!supplied) {
    console.log(`\n  PASSWORD: ${password}\n`)
    console.log('  Shown once. Store it now and change it after signing in.')
  }
}

main()
  .catch((err) => {
    console.error('reset-admin failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
