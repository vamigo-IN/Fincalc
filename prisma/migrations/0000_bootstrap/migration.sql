-- 0000_bootstrap — extensions and the SQL Prisma cannot express.
-- Must run BEFORE any table: @default(dbgenerated("uuidv7()")) references the
-- function at table-creation time. See docs/fincalc-2.0/06 §5.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- PostgreSQL 17 has no built-in uuidv7() (it lands in 18). Server-generated rows
-- must share the client's id ordering properties, so we ship one.
-- Layout: 48-bit unix_ts_ms | version 7 | rand_a | variant | rand_b
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
                PLACING substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint)
                                  FROM 3 FOR 6)
                FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid;
$$ LANGUAGE sql VOLATILE;
