-- 0003 — fix next_sync_rev(): set updated_at on INSERT.
--
-- `sync_state.updated_at` is NOT NULL with no database default, because Prisma's
-- @updatedAt is applied by the CLIENT. A raw-SQL insert therefore has to supply
-- it explicitly. The original 0002 body omitted it, so the very first write for
-- any user failed with:
--     null value in column "updated_at" violates not-null constraint
-- Only the first write per user hit it — the ON CONFLICT branch already set
-- updated_at — which is exactly the kind of bug that survives a smoke test and
-- breaks every new signup.

CREATE OR REPLACE FUNCTION next_sync_rev(p_user_id UUID) RETURNS BIGINT AS $$
  INSERT INTO sync_state (user_id, rev_counter, updated_at)
       VALUES (p_user_id, 1, now())
  ON CONFLICT (user_id) DO UPDATE
          SET rev_counter = sync_state.rev_counter + 1,
              updated_at  = now()
    RETURNING rev_counter;
$$ LANGUAGE sql VOLATILE;
