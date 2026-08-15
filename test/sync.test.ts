/**
 * Sync protocol tests — docs/fincalc-2.0/02 §4, 05 §7.
 *
 * These run against the REAL database. Sync bugs are silent: nothing errors, the
 * user simply loses a row or sees a resurrected one weeks later. A mock would
 * happily agree with a broken implementation, so these do not use one.
 *
 *   cd server && docker compose up -d && npx tsx --test test/sync.test.ts
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { uuidv7 } from 'uuidv7'

import { unsafeSystemClient as db } from '../src/db/prisma.js'
import { pull, push } from '../src/modules/sync/sync.service.js'
import { AppError } from '../src/errors.js'

const created: string[] = []

async function newUser(): Promise<string> {
  const id = uuidv7()
  await db.user.create({
    data: {
      id,
      email: `sync-${id}@test.local`,
      // A REAL bcrypt hash. ck_users__bcrypt_shape requires exactly 53 chars
      // after the $2b$NN$ prefix; the earlier placeholder had 55 and was
      // silently accepted only because the constraint did not exist yet.
      passwordHash: '$2b$10$kU3wmcKFsAv/tKag/Oqwa.6L4DyPjWaIirUcMYfio32zBbbuOGIcW',
    },
  })
  await db.syncState.create({ data: { userId: id } })
  created.push(id)
  return id
}

function goalRow(over: Record<string, unknown> = {}) {
  return {
    id: uuidv7(),
    name: 'Emergency fund',
    goalType: 'emergency',
    targetAmountPaise: '50000000',
    monthlyContributionPaise: '300000',
    expectedReturnRateMicro: 70000,
    startDate: '2026-08-01',
    targetDate: '2027-08-01',
    priority: 10,
    status: 'active',
    updatedAt: new Date().toISOString(),
    ...over,
  }
}

before(async () => {
  await db.$connect()
})

after(async () => {
  if (created.length) {
    await db.user.deleteMany({ where: { id: { in: created } } })
  }
  await db.$disconnect()
})

describe('sync · pull', () => {
  test('a fresh account bootstraps to an empty set at rev 0', async () => {
    const userId = await newUser()
    const res = await pull(userId, 0n)
    assert.equal(res.serverRev, '0')
    assert.equal(res.hasMore, false)
    assert.deepEqual(res.changes, {})
    assert.deepEqual(res.tombstones, [])
  })

  test('the cursor advances and a second pull at that cursor is empty', async () => {
    const userId = await newUser()
    const first = await push(userId, { goals: [goalRow()] }, [])
    assert.equal(first.applied.goals, 1)

    const afterPush = await pull(userId, 0n)
    assert.equal(afterPush.changes.goals?.length, 1)
    assert.equal(afterPush.serverRev, first.serverRev)

    // Everything at or below serverRev has been delivered — property 1.
    const idempotent = await pull(userId, BigInt(afterPush.serverRev))
    assert.deepEqual(idempotent.changes, {})
  })

  test('a cursor below the purge horizon forces a bootstrap', async () => {
    const userId = await newUser()
    await push(userId, { goals: [goalRow()] }, [])
    // Simulate the tombstone-purge job having advanced the horizon.
    //
    // Both counters move: ck_sync_state__horizon enforces
    // min_retained_rev <= rev_counter, because the purge job can only advance
    // the horizon up to revisions that actually exist. The earlier version of
    // this test set the horizon ABOVE the counter — a state the database now
    // correctly refuses to represent.
    await db.syncState.update({
      where: { userId },
      data: { revCounter: 120n, minRetainedRev: 100n },
    })

    await assert.rejects(
      () => pull(userId, 5n),
      (e: unknown) => e instanceof AppError && e.code === 'SYNC_CURSOR_TOO_OLD',
      'a client below min_retained_rev can never learn about the purged deletions',
    )
    // since=0 is a bootstrap and must still be allowed.
    await assert.doesNotReject(() => pull(userId, 0n))
  })
})

describe('sync · push and last-write-wins', () => {
  test('one revision is allocated per batch, not per row', async () => {
    const userId = await newUser()
    const res = await push(userId, { goals: [goalRow(), goalRow(), goalRow()] }, [])
    assert.equal(res.applied.goals, 3)

    const rows = await db.goal.findMany({ where: { userId }, select: { syncRev: true } })
    const revs = new Set(rows.map((r) => r.syncRev.toString()))
    assert.equal(revs.size, 1, 'a batch is one logical revision')
  })

  test('a NEWER client write wins', async () => {
    const userId = await newUser()
    const row = goalRow({ updatedAt: '2026-08-01T10:00:00.000Z', name: 'Original' })
    await push(userId, { goals: [row] }, [])

    const res = await push(
      userId,
      { goals: [{ ...row, name: 'Updated', updatedAt: '2026-08-01T11:00:00.000Z' }] },
      [],
    )
    assert.equal(res.applied.goals, 1)
    assert.equal(res.conflicts.length, 0)

    const stored = await db.goal.findFirst({ where: { id: row.id as string } })
    assert.equal(stored?.name, 'Updated')
  })

  test('an OLDER client write loses and returns the server row', async () => {
    const userId = await newUser()
    const row = goalRow({ updatedAt: '2026-08-01T12:00:00.000Z', name: 'Server wins' })
    await push(userId, { goals: [row] }, [])

    const res = await push(
      userId,
      { goals: [{ ...row, name: 'Stale phone', updatedAt: '2026-08-01T09:00:00.000Z' }] },
      [],
    )

    assert.equal(res.applied.goals, undefined)
    assert.equal(res.conflicts.length, 1)
    assert.equal(res.conflicts[0]?.reason, 'STALE_UPDATE')
    assert.equal((res.conflicts[0]?.server as { name: string }).name, 'Server wins')

    const stored = await db.goal.findFirst({ where: { id: row.id as string } })
    assert.equal(stored?.name, 'Server wins', 'a stale push must not overwrite newer data')
  })

  test('the client timestamp is preserved, not stamped by the server', async () => {
    const userId = await newUser()
    const clientTime = '2026-08-01T10:30:00.000Z'
    const row = goalRow({ updatedAt: clientTime })
    await push(userId, { goals: [row] }, [])

    const stored = await db.goal.findFirst({ where: { id: row.id as string } })
    assert.equal(
      stored?.updatedAt.toISOString(),
      clientTime,
      'Prisma @updatedAt must be bypassed — the client timestamp IS the LWW key, ' +
        'and stamping it server-side makes whoever pushed last always win',
    )
  })

  test('re-pushing an identical row is a no-op conflict, not a duplicate', async () => {
    const userId = await newUser()
    const row = goalRow({ updatedAt: '2026-08-01T10:00:00.000Z' })
    await push(userId, { goals: [row] }, [])
    const again = await push(userId, { goals: [row] }, [])

    assert.equal(again.conflicts.length, 1, 'equal timestamps do not win — strict <')
    const count = await db.goal.count({ where: { id: row.id as string } })
    assert.equal(count, 1)
  })
})

describe('sync · deletes and tombstones', () => {
  test('a delete is a tombstone an offline device can learn about', async () => {
    const userId = await newUser()
    const row = goalRow()
    await push(userId, { goals: [row] }, [])
    const beforeDelete = await pull(userId, 0n)

    const del = await push(userId, {}, [
      { entityTable: 'goals', entityId: row.id as string, deletedAt: new Date().toISOString() },
    ])
    assert.equal(del.applied.deletes, 1)

    // The row is soft-deleted, never removed.
    const stored = await db.goal.findFirst({ where: { id: row.id as string } })
    assert.ok(stored, 'a hard delete is invisible to an offline device');
    assert.ok(stored?.deletedAt, 'deletedAt must be set')

    // A device sitting on the pre-delete cursor learns about it.
    const catchUp = await pull(userId, BigInt(beforeDelete.serverRev))
    assert.equal(catchUp.tombstones.length, 1)
    assert.equal(catchUp.tombstones[0]?.entityId, row.id)
  })

  test('deleting twice is idempotent', async () => {
    const userId = await newUser()
    const row = goalRow()
    await push(userId, { goals: [row] }, [])
    const at = new Date().toISOString()
    await push(userId, {}, [{ entityTable: 'goals', entityId: row.id as string, deletedAt: at }])
    const second = await push(userId, {}, [
      { entityTable: 'goals', entityId: row.id as string, deletedAt: at },
    ])
    // The second is reported as NOT_FOUND (already deleted) but must not throw,
    // and must leave exactly one tombstone.
    assert.equal(second.rejected.length + (second.applied.deletes ?? 0), 1)
    const tombs = await db.syncTombstone.count({ where: { userId, entityId: row.id as string } })
    assert.equal(tombs, 1)
  })
})

describe('sync · safety', () => {
  test("a row belonging to another user is rejected, not overwritten", async () => {
    const victim = await newUser()
    const attacker = await newUser()

    const row = goalRow({ name: 'Victim goal' })
    await push(victim, { goals: [row] }, [])

    const res = await push(
      attacker,
      { goals: [{ ...row, name: 'pwned', updatedAt: new Date(Date.now() + 60_000).toISOString() }] },
      [],
    )

    assert.equal(res.rejected.length, 1)
    assert.equal(res.rejected[0]?.reason, 'ROW_NOT_OWNED')

    const stored = await db.goal.findFirst({ where: { id: row.id as string } })
    assert.equal(stored?.name, 'Victim goal')
    assert.equal(stored?.userId, victim)
  })

  test('an unregistered table is rejected, never silently dropped', async () => {
    const userId = await newUser()
    // `loans` is a valid sync_entity_type value but has no registry entry yet.
    // Rejecting explicitly — rather than ignoring the key — is what stops a
    // client silently losing writes to a table the server has not implemented.
    const res = await push(userId, { loans: [{ id: uuidv7(), updatedAt: new Date().toISOString() }] }, [])
    assert.equal(res.rejected[0]?.reason, 'SYNC_TABLE_NOT_WRITABLE')
  })

  test('a newly registered table (transactions) IS writable', async () => {
    const userId = await newUser()
    const category = await db.expenseCategory.findFirst({
      where: { userId: null, categoryKey: 'groceries' },
      select: { id: true },
    })
    assert.ok(category, 'seed must have run: expense_categories is empty')

    const res = await push(userId, {
      transactions: [{
        id: uuidv7(),
        categoryId: category.id,
        amountPaise: '45000',
        txnType: 'expense',
        source: 'quick_add',
        note: 'Auto',
        // Carried from v1, before partitioning makes it part of the key (05 R3).
        occurredOn: '2026-08-09',
        updatedAt: new Date().toISOString(),
      }],
    }, [])

    assert.equal(res.applied.transactions, 1, JSON.stringify(res.rejected))
    const pulled = await pull(userId, 0n)
    assert.equal((pulled.changes.transactions as unknown[]).length, 1)
  })

  test('a malformed row is rejected without failing its whole batch', async () => {
    const userId = await newUser()
    const good = goalRow()
    const res = await push(
      userId,
      { goals: [good, { id: uuidv7(), updatedAt: new Date().toISOString(), name: '' }] },
      [],
    )
    assert.equal(res.applied.goals, 1, 'the valid row still lands')
    assert.equal(res.rejected.length, 1)
    assert.equal(res.rejected[0]?.reason, 'VALIDATION_FAILED')
  })

  test("one user's pull never contains another's rows", async () => {
    const a = await newUser()
    const b = await newUser()
    await push(a, { goals: [goalRow({ name: 'A only' })] }, [])
    await push(b, { goals: [goalRow({ name: 'B only' })] }, [])

    const pulledB = await pull(b, 0n)
    const names = (pulledB.changes.goals ?? []).map((g) => (g as { name: string }).name)
    assert.deepEqual(names, ['B only'])
  })

  test('per-user revisions are independent', async () => {
    const a = await newUser()
    const b = await newUser()
    await push(a, { goals: [goalRow()] }, [])
    await push(a, { goals: [goalRow()] }, [])
    const bRes = await push(b, { goals: [goalRow()] }, [])
    assert.equal(bRes.serverRev, '1', "another user's writes must not advance this cursor")
  })
})
