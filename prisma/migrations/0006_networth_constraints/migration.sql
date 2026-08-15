-- Net worth constraints — docs/fincalc-2.0/05 §13.
--
-- Same reasoning as migration 0005: assets and liabilities were unimplemented
-- when 0004 restored the schema's CHECKs, so the guarantees go in before the
-- first row exists rather than after cleaning data that should never have been
-- storable.

ALTER TABLE assets
  -- Zero is legal — an account someone has emptied but still tracks. Negative
  -- is not: a liability entered as a negative asset would corrupt every
  -- allocation share, which divides by the asset total.
  ADD CONSTRAINT ck_assets__value CHECK (current_value_paise >= 0),

  -- A valuation dated in the future is a typo (2062 for 2026), and it would
  -- win every "latest valuation" query forever.
  ADD CONSTRAINT ck_assets__as_of CHECK (as_of_date <= CURRENT_DATE + 1),

  ADD CONSTRAINT ck_assets__name CHECK (length(btrim(name)) > 0);

ALTER TABLE liabilities
  ADD CONSTRAINT ck_liabilities__outstanding CHECK (outstanding_paise >= 0),
  ADD CONSTRAINT ck_liabilities__rate
    CHECK (interest_rate_micro BETWEEN 0 AND 1000000),
  ADD CONSTRAINT ck_liabilities__as_of
    CHECK (as_of_date <= CURRENT_DATE + 1),
  ADD CONSTRAINT ck_liabilities__name CHECK (length(btrim(name)) > 0);

-- At most one liability MIRRORING a given loan.
--
-- This is the double-counting guard. A loan tracked in the loans module and a
-- liability row for the same debt would both land in the net-worth total,
-- halving the user's apparent net worth on data they entered in good faith.
-- The client derives loan liabilities rather than storing them, so this index
-- exists to stop a second client — or a future import — from reintroducing the
-- duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS ux_liabilities__source_loan
  ON liabilities (source_loan_id)
  WHERE source_loan_id IS NOT NULL AND deleted_at IS NULL;

-- The allocation view groups by class over live rows only.
CREATE INDEX IF NOT EXISTS ix_assets__user_class_live
  ON assets (user_id, asset_class) WHERE deleted_at IS NULL;
