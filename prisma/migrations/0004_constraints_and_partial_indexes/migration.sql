-- 0004 — the business rules Prisma cannot express.
--
-- WHY THIS EXISTS: migration 0001 was generated with `prisma migrate diff` from
-- schema.prisma. Prisma cannot express CHECK constraints, partial indexes or
-- generated columns, so ALL of them were silently absent. docs/fincalc-2.0/06 §5
-- says they must be hand-written; they were not. The database had zero CHECK
-- constraints and zero partial indexes.
--
-- The most serious consequence: there was NO unique index on users.email at all.
-- The register flow's findFirst check is a race — two concurrent signups both
-- pass it and both insert. A uniqueness rule enforced only in application code
-- is not enforced.

-- ── users ────────────────────────────────────────────────────────────────────
-- PARTIAL on deleted_at IS NULL so a purged account frees its address for
-- re-registration (05 §4.1). A plain unique would make erasure permanent for
-- that email, which is the opposite of what DPDP erasure should mean.
CREATE UNIQUE INDEX IF NOT EXISTS ux_users__email_live
  ON users (email) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_users__pending_deletion
  ON users (deletion_requested_at) WHERE status = 'pending_deletion';

ALTER TABLE users
  ADD CONSTRAINT ck_users__email_len CHECK (length(email) BETWEEN 3 AND 254),
  ADD CONSTRAINT ck_users__failed_bounds CHECK (failed_login_count BETWEEN 0 AND 1000),
  -- $2<a|b|y>$<cost>$<22-char salt><31-char hash> = 53 chars after the prefix.
  -- Asserts the bcrypt shape so a plaintext or SHA-256 value can never be
  -- stored by a bad migration or a careless script.
  ADD CONSTRAINT ck_users__bcrypt_shape
    CHECK (password_hash ~ '^\$2[aby]\$[0-9]{2}\$.{53}$');

-- ── sync control ─────────────────────────────────────────────────────────────
ALTER TABLE sync_state
  ADD CONSTRAINT ck_sync_state__horizon CHECK (min_retained_rev <= rev_counter);

-- The counter row is updated on EVERY write in the system. fillfactor 70 keeps
-- those updates HOT so the row never leaves its page between vacuums; at the
-- default 100 this becomes a badly bloated table within a year (05 §4.2).
ALTER TABLE sync_state SET (fillfactor = 70);
ALTER TABLE sync_state SET (
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 50,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold = 100
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sync_tombstones__entity
  ON sync_tombstones (user_id, entity_table, entity_id);
CREATE INDEX IF NOT EXISTS ix_sync_tombstones__purge
  ON sync_tombstones (deleted_at) WHERE purged_at IS NULL;

-- ── goals ────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS ix_goals__user_live
  ON goals (user_id, priority, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_goals__target_date
  ON goals (user_id, target_date) WHERE status = 'active' AND deleted_at IS NULL;

ALTER TABLE goals
  ADD CONSTRAINT ck_goals__target_pos CHECK (target_amount_paise > 0),
  ADD CONSTRAINT ck_goals__current_nneg CHECK (current_amount_paise >= 0),
  ADD CONSTRAINT ck_goals__monthly_nneg CHECK (monthly_contribution_paise >= 0),
  ADD CONSTRAINT ck_goals__dates CHECK (target_date > start_date),
  ADD CONSTRAINT ck_goals__rate_bounds CHECK (expected_return_rate_micro BETWEEN -500000 AND 1000000),
  ADD CONSTRAINT ck_goals__priority CHECK (priority BETWEEN 1 AND 1000),
  ADD CONSTRAINT ck_goals__name_len CHECK (length(name) BETWEEN 1 AND 120);

-- A withdrawal or correction is a legitimate negative contribution; forbidding
-- it would push users into deleting rows and losing the audit trail. Zero is
-- meaningless and is rejected.
ALTER TABLE goal_contributions
  ADD CONSTRAINT ck_goal_contributions__amount CHECK (amount_paise <> 0);
CREATE INDEX IF NOT EXISTS ix_goal_contributions__goal_date
  ON goal_contributions (goal_id, contributed_on DESC) WHERE deleted_at IS NULL;

-- ── expense categories ───────────────────────────────────────────────────────
-- is_system was a plain NOT NULL boolean the application had to remember to set.
-- GENERATED means it can never disagree with user_id.
ALTER TABLE expense_categories DROP COLUMN IF EXISTS is_system;
ALTER TABLE expense_categories
  ADD COLUMN is_system BOOLEAN GENERATED ALWAYS AS (user_id IS NULL) STORED;

-- Two partial uniques, not one: a user may create their OWN row with the same
-- category_key as a system default in order to rename it. The repository then
-- resolves COALESCE(user row, system row) per key (05 §4.4).
CREATE UNIQUE INDEX IF NOT EXISTS ux_expense_categories__system_key
  ON expense_categories (category_key) WHERE user_id IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_expense_categories__user_key
  ON expense_categories (user_id, category_key) WHERE user_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_expense_categories__user_sort
  ON expense_categories (user_id, sort_order) WHERE deleted_at IS NULL;

ALTER TABLE expense_categories
  ADD CONSTRAINT ck_expense_categories__key CHECK (category_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  ADD CONSTRAINT ck_expense_categories__color CHECK (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  ADD CONSTRAINT ck_expense_categories__name CHECK (length(name) BETWEEN 1 AND 60),
  ADD CONSTRAINT ck_expense_categories__self CHECK (parent_id IS DISTINCT FROM id);

-- ── budgets ──────────────────────────────────────────────────────────────────
-- Without this a user can hold two budgets for the same month and the monthly
-- close has no single row to write to.
CREATE UNIQUE INDEX IF NOT EXISTS ux_budgets__user_month
  ON budgets (user_id, period_month) WHERE deleted_at IS NULL;

ALTER TABLE budgets
  ADD CONSTRAINT ck_budgets__first_of_month CHECK (EXTRACT(DAY FROM period_month) = 1),
  ADD CONSTRAINT ck_budgets__income_nneg CHECK (income_paise >= 0),
  ADD CONSTRAINT ck_budgets__savings_nneg CHECK (planned_savings_paise >= 0),
  ADD CONSTRAINT ck_budgets__savings_le_inc CHECK (planned_savings_paise <= income_paise);

CREATE UNIQUE INDEX IF NOT EXISTS ux_budget_categories__budget_cat
  ON budget_categories (budget_id, category_id) WHERE deleted_at IS NULL;
ALTER TABLE budget_categories
  ADD CONSTRAINT ck_budget_categories__alloc CHECK (allocated_paise >= 0);

-- ── transactions ─────────────────────────────────────────────────────────────
-- Sign is NEVER used to encode direction: a -500 expense and a +500 income are
-- two different facts, and a sign convention is the classic source of a
-- double-negative bug in a SUM() when someone forgets the filter.
ALTER TABLE transactions
  ADD CONSTRAINT ck_transactions__amt CHECK (amount_paise > 0),
  ADD CONSTRAINT ck_transactions__note CHECK (length(note) <= 200),
  ADD CONSTRAINT ck_transactions__date CHECK (occurred_on BETWEEN DATE '2000-01-01' AND DATE '2100-01-01');

CREATE INDEX IF NOT EXISTS ix_transactions__user_month
  ON transactions (user_id, occurred_on DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_transactions__user_cat_month
  ON transactions (user_id, category_id, occurred_on) WHERE deleted_at IS NULL;

-- transactions is the hot table and append-mostly; the default scale factor of
-- 0.2 would wait for 1.6M dead tuples at 8M rows before vacuuming (05 §11.4).
ALTER TABLE transactions SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_cost_delay = 2,
  autovacuum_analyze_scale_factor = 0.02
);

-- ── singletons ───────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS ux_emergency_funds__user
  ON emergency_funds (user_id) WHERE deleted_at IS NULL;
ALTER TABLE emergency_funds
  ADD CONSTRAINT ck_emergency_funds__months CHECK (target_months BETWEEN 3 AND 12),
  ADD CONSTRAINT ck_emergency_funds__corpus CHECK (current_corpus_paise >= 0);

-- Exactly one primary plan, so the dashboard never needs an ORDER BY … LIMIT 1
-- that could flip between devices. Multiple scenarios are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS ux_retirement_plans__primary
  ON retirement_plans (user_id) WHERE is_primary AND deleted_at IS NULL;
ALTER TABLE retirement_plans
  ADD CONSTRAINT ck_retirement__ages CHECK (
    current_age BETWEEN 15 AND 100
    AND retirement_age > current_age
    AND life_expectancy > retirement_age
    AND life_expectancy <= 120);

-- ── advisor / commerce ───────────────────────────────────────────────────────
-- A rule holds AT MOST ONE active recommendation per user, so a nightly re-run
-- cannot stack five copies of "build an emergency fund" in the feed.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ar__user_rule_live
  ON advisor_recommendations (user_id, rule_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_ar__user_feed
  ON advisor_recommendations (user_id, rank_score DESC, generated_at DESC) WHERE status = 'active';

-- dedupe_key is composed as 'emi_due:<loan>:<date>', so a worker that runs twice
-- hits a unique violation and skips instead of pushing the same reminder again.
CREATE UNIQUE INDEX IF NOT EXISTS ux_notif__dedupe
  ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_ent__user_feature_live
  ON entitlements (user_id, feature_key) WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_tr__active
  ON tax_rulesets (fy_label) WHERE status = 'active';
