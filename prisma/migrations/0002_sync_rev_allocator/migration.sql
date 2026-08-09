-- 0002 — the per-user monotonic revision allocator (docs/fincalc-2.0/05 §7.1).
--
-- MUST run AFTER the tables exist. A SQL-language function body is validated
-- eagerly at CREATE time, so defining this in 0000_bootstrap fails with
-- 'relation "sync_state" does not exist'.
--
-- INSERT ... ON CONFLICT rather than a bare UPDATE, so a user whose sync_state
-- row was never created gets one lazily instead of sitting at rev 0 forever and
-- never being able to pull.

-- The per-user monotonic revision allocator (05 §7.1).
-- INSERT ... ON CONFLICT rather than a bare UPDATE so a user whose sync_state row
-- was never created gets one lazily, instead of silently sitting at rev 0 forever.
CREATE OR REPLACE FUNCTION next_sync_rev(p_user_id UUID) RETURNS BIGINT AS $$
  INSERT INTO sync_state (user_id, rev_counter)
       VALUES (p_user_id, 1)
  ON CONFLICT (user_id) DO UPDATE
          SET rev_counter = sync_state.rev_counter + 1,
              updated_at  = now()
    RETURNING rev_counter;
$$ LANGUAGE sql VOLATILE;
