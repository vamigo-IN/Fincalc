-- Loan constraints — docs/fincalc-2.0/05 §13.
--
-- Migration 0004 restored CHECKs across the schema but SKIPPED loans and
-- loan_payments, which were still unimplemented at the time. They are being
-- implemented now, so the guarantees go in BEFORE the first row is written —
-- adding a CHECK to a populated table means first cleaning data that should
-- never have been storable.
--
-- Every constraint here corresponds to something the Dart engine already
-- rejects (LoanCalculator._validate). That duplication is deliberate: the
-- client's validation gives a good error message, and the database's makes the
-- bad state unrepresentable regardless of which client wrote it.

-- ── loans ────────────────────────────────────────────────────────────────────

ALTER TABLE loans
  -- A zero-principal loan is not a loan, and it divides by zero in every ratio
  -- the dashboard computes.
  ADD CONSTRAINT ck_loans__principal CHECK (principal_paise > 0),

  -- 0 is legal: "no cost EMI" on a consumer durable is a real product. The
  -- ceiling is 100% — above that the row is a data-entry error, not a loan.
  ADD CONSTRAINT ck_loans__rate CHECK (interest_rate_micro BETWEEN 0 AND 1000000),

  -- 480 months is 40 years, longer than any Indian home loan on offer. The
  -- lower bound matters more: a tenure of 0 makes the EMI formula divide by
  -- zero.
  ADD CONSTRAINT ck_loans__tenure CHECK (tenure_months BETWEEN 1 AND 480),

  ADD CONSTRAINT ck_loans__emi CHECK (emi_paise > 0),

  -- Outstanding may EQUAL the principal (nothing paid yet) but never exceed it:
  -- that would mean the balance grew, which only happens if the EMI fails to
  -- cover the interest — a state the engine refuses to produce.
  ADD CONSTRAINT ck_loans__outstanding
    CHECK (outstanding_paise >= 0 AND outstanding_paise <= principal_paise),

  ADD CONSTRAINT ck_loans__prepayment CHECK (prepayment_total_paise >= 0),

  -- The day of the month the EMI is debited. 29-31 are legal and handled by the
  -- scheduler clamping to the month's last day; rejecting them here would stop
  -- users entering the date their bank actually uses.
  ADD CONSTRAINT ck_loans__emi_day CHECK (emi_day BETWEEN 1 AND 31);

-- Closed loans stay in the table for history but must not appear in the EMI
-- burden. The partial index keeps the dashboard's hot query off the dead rows.
CREATE INDEX IF NOT EXISTS ix_loans__user_active
  ON loans (user_id) WHERE status = 'active' AND deleted_at IS NULL;

-- ── loan_payments ────────────────────────────────────────────────────────────

ALTER TABLE loan_payments
  ADD CONSTRAINT ck_loan_payments__amount CHECK (amount_paise > 0),

  ADD CONSTRAINT ck_loan_payments__split
    CHECK (principal_paise >= 0 AND interest_paise >= 0),

  -- Instalment numbers are 1-based when present. NULL is legal and means a
  -- prepayment, which belongs to no instalment.
  ADD CONSTRAINT ck_loan_payments__instalment
    CHECK (instalment_no IS NULL OR instalment_no > 0),

  -- A prepayment carries no instalment number, and an instalment is not a
  -- prepayment. Without this the two concepts drift and the schedule cannot be
  -- reconstructed from the rows.
  ADD CONSTRAINT ck_loan_payments__prepayment_shape
    CHECK (NOT is_prepayment OR instalment_no IS NULL),

  -- A payment marked paid must say WHEN. Otherwise "paid" is unfalsifiable and
  -- the overdue query silently under-reports.
  ADD CONSTRAINT ck_loan_payments__paid_on
    CHECK (status <> 'paid' OR paid_on IS NOT NULL);

-- One row per instalment per loan. A duplicate would double-count in every
-- total the app shows, and two devices logging the same EMI offline is exactly
-- how that happens.
CREATE UNIQUE INDEX IF NOT EXISTS ux_loan_payments__instalment
  ON loan_payments (loan_id, instalment_no)
  WHERE instalment_no IS NOT NULL AND deleted_at IS NULL;
