-- Credit health: make "unanswered" representable — docs/fincalc-2.0/11 §10, §4.
--
-- The answer columns were NOT NULL DEFAULT 0. For this module that is a defect,
-- not a convenience: a stored 0 in `missed_payments_12m` means either "no missed
-- payments" — the STRONGEST possible status for the highest-weighted factor —
-- or "we never asked". Those must not be the same row.
--
-- The whole module rests on the tri-state (11 §4): a factor the user has not
-- answered is dropped from the assessment, never scored. With a defaulted zero
-- the engine would instead award full marks on payment history to someone who
-- has answered nothing, and the three-factor guard would never fire because
-- every factor would look answered.
--
-- NULL now means unanswered. Safe to apply as a plain ALTER: the module was
-- never implemented, so the table is empty.

ALTER TABLE credit_health_inputs
  ALTER COLUMN total_card_limit_paise DROP DEFAULT,
  ALTER COLUMN total_card_limit_paise DROP NOT NULL,
  ALTER COLUMN total_card_balance_paise DROP DEFAULT,
  ALTER COLUMN total_card_balance_paise DROP NOT NULL,
  ALTER COLUMN missed_payments_12m DROP DEFAULT,
  ALTER COLUMN missed_payments_12m DROP NOT NULL,
  ALTER COLUMN oldest_account_months DROP DEFAULT,
  ALTER COLUMN oldest_account_months DROP NOT NULL,
  ALTER COLUMN recent_enquiries_6m DROP DEFAULT,
  ALTER COLUMN recent_enquiries_6m DROP NOT NULL;

-- Bounds, so a typo cannot produce an assessment. Each permits NULL, because
-- unanswered is a legitimate state for every one of these.
ALTER TABLE credit_health_inputs
  ADD CONSTRAINT ck_chi__limits CHECK (
    (total_card_limit_paise IS NULL OR total_card_limit_paise >= 0)
    AND (total_card_balance_paise IS NULL OR total_card_balance_paise >= 0)),

  -- 60 missed payments in 12 months is impossible; the cap catches a slipped
  -- decimal rather than trusting the client.
  ADD CONSTRAINT ck_chi__missed CHECK (
    missed_payments_12m IS NULL OR missed_payments_12m BETWEEN 0 AND 60),

  -- 900 months is 75 years of credit history, comfortably beyond any real case.
  ADD CONSTRAINT ck_chi__age CHECK (
    oldest_account_months IS NULL OR oldest_account_months BETWEEN 0 AND 900),

  ADD CONSTRAINT ck_chi__enquiries CHECK (
    recent_enquiries_6m IS NULL OR recent_enquiries_6m BETWEEN 0 AND 50);

-- One live self-report per user. The module asks the same six questions each
-- time, so a second row would mean two different answers to "how many payments
-- did you miss?" with nothing to say which is current.
CREATE UNIQUE INDEX IF NOT EXISTS ux_chi__user
  ON credit_health_inputs (user_id) WHERE deleted_at IS NULL;
