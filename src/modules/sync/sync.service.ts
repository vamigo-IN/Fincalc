/**
 * Offline sync — docs/fincalc-2.0/02 §4, 05 §7 (T2).
 *
 * Design in one paragraph: the device owns ids (client-generated UUIDv7), every
 * syncable row carries a per-user monotonic `sync_rev`, deletes are tombstones
 * rather than DELETEs, and conflicts resolve last-write-wins on `updated_at`.
 * LWW is defensible here ONLY because every row is owned by exactly one user —
 * there is no shared document for two people to edit.
 *
 * The three properties this file exists to guarantee:
 *   1. A pull that returns `serverRev = N` has returned EVERYTHING at or below N.
 *   2. A push never overwrites a row the server has newer data for; the client
 *      is told and adopts the server's version.
 *   3. A delete is visible to a device that was offline when it happened.
 */
import { Prisma } from '@prisma/client'
import { uuidv7 } from 'uuidv7'

import { unsafeSystemClient as db } from '../../db/prisma.js'
import { AppError } from '../../errors.js'
import { logger } from '../../obs/logger.js'
import { findEntity, implementedTables, type SyncEntity } from './registry.js'

export interface PullResult {
  serverRev: string
  hasMore: boolean
  changes: Record<string, unknown[]>
  tombstones: Array<{ entityTable: string; entityId: string; syncRev: string; deletedAt: string }>
}

export interface PushRow {
  [key: string]: unknown
}

export interface PushResult {
  serverRev: string
  applied: Record<string, number>
  rejected: Array<{ entityTable: string; entityId: string; reason: string; detail?: string }>
  conflicts: Array<{ entityTable: string; entityId: string; reason: string; server: unknown }>
}

const MAX_ROWS_PER_TABLE = 500
const DEFAULT_PULL_LIMIT = 500


/**
 * Resolve a Prisma model delegate by name.
 *
 * The registry is data, so the lookup is dynamic. A miss means the registry
 * names a model that does not exist on the client — a programming error, not a
 * runtime condition, so it throws rather than being silently skipped.
 */
interface Delegate {
  findMany(a: unknown): Promise<unknown[]>
  findFirst(a: unknown): Promise<Record<string, unknown> | null>
  create(a: unknown): Promise<unknown>
  updateMany(a: unknown): Promise<{ count: number }>
}

function delegateFor(client: unknown, model: string): Delegate {
  const d = (client as Record<string, Delegate | undefined>)[model]
  if (!d) {
    throw new AppError('INTERNAL_ERROR', {
      context: { reason: `sync registry references unknown Prisma model "${model}"` },
    })
  }
  return d
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allocate this user's next revision INSIDE the writing transaction.
 *
 * The row lock serialises allocation, and — the property that actually matters —
 * makes it impossible for a higher rev to commit before a lower one. A plain
 * sequence would allow exactly that, and a client polling in the gap would record
 * the higher cursor and never see the lower row again: silent, permanent,
 * per-user data loss (05 §7.2).
 */
async function nextSyncRev(tx: Prisma.TransactionClient, userId: string): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ rev: bigint }>>`
    SELECT next_sync_rev(${userId}::uuid) AS rev`
  const rev = rows[0]?.rev
  if (rev === undefined) throw new AppError('INTERNAL_ERROR', { context: { reason: 'no sync rev' } })
  return rev
}

async function currentRev(userId: string): Promise<{ revCounter: bigint; minRetainedRev: bigint }> {
  const state = await db.syncState.findUnique({
    where: { userId },
    select: { revCounter: true, minRetainedRev: true },
  })
  // A user created before sync_state existed, or a restored backup: create it
  // lazily rather than 500-ing.
  if (!state) {
    await db.syncState.upsert({ where: { userId }, update: {}, create: { userId } })
    return { revCounter: 0n, minRetainedRev: 0n }
  }
  return state
}

// ── pull ─────────────────────────────────────────────────────────────────────

export async function pull(
  userId: string,
  since: bigint,
  limit = DEFAULT_PULL_LIMIT,
): Promise<PullResult> {
  const { revCounter, minRetainedRev } = await currentRev(userId)

  // Below the purge horizon there are deletions this client can never learn
  // about, so an incremental catch-up would silently keep resurrected rows.
  // Force a bootstrap instead (05 §7.3).
  if (since > 0n && since < minRetainedRev) {
    throw new AppError('SYNC_CURSOR_TOO_OLD', {
      context: { since: since.toString(), minRetainedRev: minRetainedRev.toString() },
    })
  }

  const changes: Record<string, unknown[]> = {}
  let hasMore = false

  for (const entity of implementedTables().map((t) => findEntity(t)!)) {
    const rows = await delegateFor(db, entity.model).findMany({
      where: { userId, syncRev: { gt: since } },
      orderBy: { syncRev: 'asc' },
      take: limit + 1,
    })
    if (rows.length > limit) {
      hasMore = true
      rows.length = limit
    }
    // Deliberately NOT filtered on deletedAt: a tombstoned row must be pullable
    // so an offline device learns the delete.
    if (rows.length) changes[entity.table] = rows.map(serialiseRow)
  }

  const tombstones = await db.syncTombstone.findMany({
    where: { userId, syncRev: { gt: since } },
    orderBy: { syncRev: 'asc' },
    take: limit,
    select: { entityTable: true, entityId: true, syncRev: true, deletedAt: true },
  })

  return {
    serverRev: revCounter.toString(),
    hasMore,
    changes,
    tombstones: tombstones.map((t) => ({
      entityTable: t.entityTable,
      entityId: t.entityId,
      syncRev: t.syncRev.toString(),
      deletedAt: t.deletedAt.toISOString(),
    })),
  }
}

/** Dates become ISO strings; BigInt is handled by the global serialiser (06 §9.1). */
function serialiseRow(row: unknown): unknown {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    out[k] = v instanceof Date ? v.toISOString() : v
  }
  return out
}

// ── push ─────────────────────────────────────────────────────────────────────

export async function push(
  userId: string,
  changes: Record<string, PushRow[]>,
  deletes: Array<{ entityTable: string; entityId: string; deletedAt: string }>,
): Promise<PushResult> {
  const applied: Record<string, number> = {}
  const rejected: PushResult['rejected'] = []
  const conflicts: PushResult['conflicts'] = []

  // Validate everything BEFORE opening the transaction. A push is all-or-nothing
  // for the rows that survive validation; a malformed row must not hold a write
  // transaction (and this user's rev counter) open while we work it out.
  const plan: Array<{ entity: SyncEntity; row: Record<string, unknown> }> = []

  for (const [table, rows] of Object.entries(changes)) {
    const entity = findEntity(table)
    if (!entity || entity.pullOnly) {
      for (const r of rows) {
        rejected.push({
          entityTable: table,
          entityId: String(r.id ?? ''),
          reason: 'SYNC_TABLE_NOT_WRITABLE',
          detail: entity ? 'pull-only' : 'not implemented',
        })
      }
      continue
    }
    if (rows.length > MAX_ROWS_PER_TABLE) {
      throw new AppError('SYNC_PAYLOAD_TOO_LARGE', {
        context: { table, rows: rows.length, max: MAX_ROWS_PER_TABLE },
      })
    }
    for (const row of rows) {
      const parsed = entity.schema.safeParse(row)
      if (!parsed.success) {
        rejected.push({
          entityTable: table,
          entityId: String(row.id ?? ''),
          reason: 'VALIDATION_FAILED',
          detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        })
        continue
      }
      plan.push({ entity, row: parsed.data as Record<string, unknown> })
    }
  }

  const validDeletes = deletes.filter((d) => {
    const entity = findEntity(d.entityTable)
    if (!entity || entity.pullOnly) {
      rejected.push({
        entityTable: d.entityTable,
        entityId: d.entityId,
        reason: 'SYNC_TABLE_NOT_WRITABLE',
      })
      return false
    }
    return true
  })

  if (plan.length === 0 && validDeletes.length === 0) {
    const { revCounter } = await currentRev(userId)
    return { serverRev: revCounter.toString(), applied, rejected, conflicts }
  }

  const serverRev = await db.$transaction(async (tx) => {
    // ONE rev for the whole batch, not one per row. The batch is a single
    // logical revision, and per-row allocation would make a 200-row bootstrap
    // take 200 trips through the same contended counter row (05 §7.1).
    const rev = await nextSyncRev(tx, userId)

    for (const { entity, row } of plan) {
      const outcome = await upsertWithLww(tx, userId, entity, row, rev)
      if (outcome.kind === 'applied') {
        applied[entity.table] = (applied[entity.table] ?? 0) + 1
      } else if (outcome.kind === 'conflict') {
        conflicts.push({
          entityTable: entity.table,
          entityId: String(row.id),
          reason: 'STALE_UPDATE',
          server: outcome.server,
        })
      } else {
        rejected.push({
          entityTable: entity.table,
          entityId: String(row.id),
          reason: outcome.reason,
        })
      }
    }

    for (const d of validDeletes) {
      const ok = await softDelete(tx, userId, d.entityTable, d.entityId, new Date(d.deletedAt), rev)
      if (ok) applied.deletes = (applied.deletes ?? 0) + 1
      else rejected.push({ entityTable: d.entityTable, entityId: d.entityId, reason: 'NOT_FOUND' })
    }

    await tx.syncState.update({ where: { userId }, data: { lastPushAt: new Date() } })
    return rev
  })

  return { serverRev: serverRev.toString(), applied, rejected, conflicts }
}

type UpsertOutcome =
  | { kind: 'applied' }
  | { kind: 'conflict'; server: unknown }
  | { kind: 'rejected'; reason: string }

/**
 * Insert-or-update with the last-write-wins guard applied ATOMICALLY.
 *
 * The guard is `AND updated_at < :clientUpdatedAt` inside the UPDATE itself, not
 * a read-then-write. Checking first and updating second is a race: two devices
 * can both read "server is older", and both write, and the loser silently wins.
 *
 * Prisma's `@updatedAt` is deliberately bypassed here — the client's timestamp IS
 * the comparison key, and letting Prisma stamp it would make every pushed row
 * look like the newest, so whoever pushed last would always win regardless of
 * when the edit actually happened (06 §9.6).
 */
async function upsertWithLww(
  tx: Prisma.TransactionClient,
  userId: string,
  entity: SyncEntity,
  row: Record<string, unknown>,
  rev: bigint,
): Promise<UpsertOutcome> {
  const id = String(row.id)
  const clientUpdatedAt = new Date(String(row.updatedAt))

  const delegate = delegateFor(tx, entity.model)

  const existing = await delegate.findFirst({ where: { id }, select: { id: true, userId: true, updatedAt: true } })

  if (existing && existing.userId !== userId) {
    // The id belongs to someone else. With 122 random bits this is not a
    // collision; it is a client bug or an attack.
    logger.warn({ userId, entity: entity.table, id }, 'sync.row_not_owned')
    return { kind: 'rejected', reason: 'ROW_NOT_OWNED' }
  }

  const data = toColumns(entity, row, userId, rev, clientUpdatedAt)

  if (!existing) {
    await delegate.create({ data })
    return { kind: 'applied' }
  }

  const res = await delegate.updateMany({
    where: { id, userId, updatedAt: { lt: clientUpdatedAt } },
    data,
  })

  if (res.count === 1) return { kind: 'applied' }

  // Zero rows updated means the server's copy is newer or identical. Hand the
  // client the server's version so it can adopt it rather than guessing.
  const server = await delegate.findFirst({ where: { id, userId } })
  return { kind: 'conflict', server: server ? serialiseRow(server) : null }
}

/** Map a validated wire row onto Prisma columns. */
function toColumns(
  entity: SyncEntity,
  row: Record<string, unknown>,
  userId: string,
  rev: bigint,
  clientUpdatedAt: Date,
): Record<string, unknown> {
  const out: Record<string, unknown> = { userId, syncRev: rev, updatedAt: clientUpdatedAt }

  for (const [k, v] of Object.entries(row)) {
    if (k === 'updatedAt') continue
    if (k === 'deletedAt') {
      out.deletedAt = v == null ? null : new Date(String(v))
      continue
    }
    // Date-only columns (L7): kept as calendar dates, never shifted by a timezone.
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      out[k] = new Date(`${v}T00:00:00.000Z`)
      continue
    }
    out[k] = v
  }
  out.id = row.id
  return out
}

/**
 * Soft delete plus a tombstone, in the SAME transaction.
 *
 * A hard delete is invisible to a device that was offline when it happened —
 * that device would push its local copy back and resurrect the row. The
 * tombstone is what lets the purge job hard-delete the original at 180 days
 * while still being able to tell a late-returning client "this id is gone".
 */
async function softDelete(
  tx: Prisma.TransactionClient,
  userId: string,
  table: string,
  id: string,
  deletedAt: Date,
  rev: bigint,
): Promise<boolean> {
  const entity = findEntity(table)
  if (!entity) return false

  const res = await delegateFor(tx, entity.model).updateMany({
    where: { id, userId, deletedAt: null },
    data: { deletedAt, syncRev: rev, updatedAt: deletedAt },
  })

  // The tombstone is written even when the row was already deleted, so a repeated
  // delete is idempotent rather than a rejection.
  await tx.syncTombstone.upsert({
    where: { userId_entityTable_entityId: { userId, entityTable: table as never, entityId: id } },
    update: { syncRev: rev, deletedAt },
    create: {
      id: uuidv7(),
      userId,
      entityTable: table as never,
      entityId: id,
      syncRev: rev,
      deletedAt,
    },
  })

  return res.count === 1
}
