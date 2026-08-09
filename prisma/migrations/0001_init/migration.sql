-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('active', 'pending_deletion', 'suspended', 'deleted');

-- CreateEnum
CREATE TYPE "device_platform" AS ENUM ('android', 'ios', 'web');

-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('user', 'admin', 'system');

-- CreateEnum
CREATE TYPE "goal_type" AS ENUM ('retirement', 'education', 'home', 'vehicle', 'travel', 'wedding', 'emergency', 'debt_payoff', 'wealth', 'custom');

-- CreateEnum
CREATE TYPE "goal_status" AS ENUM ('active', 'achieved', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "contribution_source" AS ENUM ('manual', 'sip_linked', 'bonus', 'windfall', 'rebalance');

-- CreateEnum
CREATE TYPE "txn_type" AS ENUM ('expense', 'income', 'transfer');

-- CreateEnum
CREATE TYPE "txn_source" AS ENUM ('manual', 'quick_add', 'recurring', 'bridge', 'import');

-- CreateEnum
CREATE TYPE "category_kind" AS ENUM ('essential', 'discretionary', 'savings', 'debt');

-- CreateEnum
CREATE TYPE "asset_class" AS ENUM ('cash', 'bank_deposit', 'fd_rd', 'mutual_fund', 'equity', 'bonds_debt', 'ppf_epf_nps', 'gold', 'real_estate', 'insurance_cash_value', 'other');

-- CreateEnum
CREATE TYPE "valuation_source" AS ENUM ('user', 'derived', 'imported');

-- CreateEnum
CREATE TYPE "liability_type" AS ENUM ('home_loan', 'car_loan', 'personal_loan', 'education_loan', 'gold_loan', 'credit_card', 'consumer_durable', 'business_loan', 'informal', 'other');

-- CreateEnum
CREATE TYPE "loan_type" AS ENUM ('home', 'car', 'personal', 'education', 'gold', 'business', 'consumer_durable', 'credit_card_emi', 'other');

-- CreateEnum
CREATE TYPE "loan_status" AS ENUM ('active', 'closed', 'foreclosed', 'defaulted');

-- CreateEnum
CREATE TYPE "loan_payment_status" AS ENUM ('scheduled', 'paid', 'part_paid', 'missed', 'prepayment');

-- CreateEnum
CREATE TYPE "income_stability" AS ENUM ('salaried_stable', 'salaried_variable', 'self_employed', 'single_income');

-- CreateEnum
CREATE TYPE "snapshot_period" AS ENUM ('month', 'quarter', 'fy');

-- CreateEnum
CREATE TYPE "health_band" AS ENUM ('needs_attention', 'fair', 'good', 'strong');

-- CreateEnum
CREATE TYPE "rule_status" AS ENUM ('draft', 'active', 'paused', 'retired');

-- CreateEnum
CREATE TYPE "recommendation_severity" AS ENUM ('info', 'suggested', 'important');

-- CreateEnum
CREATE TYPE "recommendation_status" AS ENUM ('active', 'dismissed', 'snoozed', 'actioned', 'expired');

-- CreateEnum
CREATE TYPE "recommendation_event_type" AS ENUM ('shown', 'opened', 'actioned', 'dismissed', 'snoozed');

-- CreateEnum
CREATE TYPE "credit_rating_band" AS ENUM ('needs_attention', 'fair', 'good', 'strong', 'excellent');

-- CreateEnum
CREATE TYPE "calendar_event_type" AS ENUM ('emi_due', 'sip_due', 'goal_contribution', 'bill_due', 'insurance_premium', 'tax_due', 'gst_due', 'fd_maturity', 'rd_maturity', 'budget_close', 'custom');

-- CreateEnum
CREATE TYPE "calendar_event_status" AS ENUM ('scheduled', 'notified', 'paid', 'skipped', 'missed');

-- CreateEnum
CREATE TYPE "recurrence_freq" AS ENUM ('once', 'daily', 'weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly');

-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('push', 'local', 'email', 'in_app');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('queued', 'sent', 'delivered', 'failed', 'suppressed', 'read');

-- CreateEnum
CREATE TYPE "article_status" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "learning_status" AS ENUM ('unread', 'in_progress', 'completed');

-- CreateEnum
CREATE TYPE "report_type" AS ENUM ('emi', 'tax', 'gst', 'fd_rd', 'ppf_nps', 'investment', 'net_worth', 'budget', 'goals', 'monthly_summary', 'annual_summary', 'loan_portfolio');

-- CreateEnum
CREATE TYPE "report_status" AS ENUM ('queued', 'generating', 'ready', 'failed', 'expired');

-- CreateEnum
CREATE TYPE "artifact_kind" AS ENUM ('pdf', 'csv', 'json');

-- CreateEnum
CREATE TYPE "subscription_platform" AS ENUM ('google_play', 'manual');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('pending_verification', 'active', 'grace', 'on_hold', 'paused', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "entitlement_source" AS ENUM ('subscription', 'promo', 'grant', 'trial');

-- CreateEnum
CREATE TYPE "rate_kind" AS ENUM ('fx', 'repo', 'inflation_cpi', 'epf', 'ppf', 'nps_tier1');

-- CreateEnum
CREATE TYPE "ruleset_status" AS ENUM ('draft', 'active', 'superseded');

-- CreateEnum
CREATE TYPE "sync_entity_type" AS ENUM ('user_profiles', 'expense_categories', 'budgets', 'budget_categories', 'transactions', 'goals', 'goal_contributions', 'loans', 'loan_payments', 'emergency_funds', 'retirement_plans', 'calendar_events', 'saved_calculations', 'credit_health_inputs', 'assets', 'asset_valuations', 'liabilities', 'learning_progress', 'recommendation_events');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" CITEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "password_hash" TEXT NOT NULL,
    "password_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "user_status" NOT NULL DEFAULT 'active',
    "failed_login_count" SMALLINT NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "deletion_requested_at" TIMESTAMPTZ(6),
    "anonymised_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "display_name" TEXT,
    "date_of_birth" DATE,
    "city" TEXT,
    "state_code" CHAR(2),
    "is_metro_for_hra" BOOLEAN NOT NULL DEFAULT false,
    "occupation" TEXT,
    "dependants" SMALLINT NOT NULL DEFAULT 0,
    "marital_status" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en_IN',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "currency_code" CHAR(3) NOT NULL DEFAULT 'INR',
    "notification_prefs" JSONB NOT NULL DEFAULT '{"emi":true,"goals":true,"budget":true,"tax":true,"advisor":true,"learn":false}',
    "onboarding_completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_devices" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "platform" "device_platform" NOT NULL,
    "model" TEXT,
    "os_version" TEXT,
    "app_version" TEXT,
    "push_enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "token_hash" BYTEA NOT NULL,
    "family_id" UUID NOT NULL,
    "parent_id" UUID,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "ip_prefix" INET,
    "user_agent" TEXT,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_audit_log" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID,
    "subject_hash" BYTEA,
    "email_attempted" CITEXT,
    "event" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "device_id" UUID,
    "ip_prefix" INET,
    "user_agent" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_state" (
    "user_id" UUID NOT NULL,
    "rev_counter" BIGINT NOT NULL DEFAULT 0,
    "min_retained_rev" BIGINT NOT NULL DEFAULT 0,
    "last_pull_at" TIMESTAMPTZ(6),
    "last_push_at" TIMESTAMPTZ(6),
    "last_bootstrap_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "sync_tombstones" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "entity_table" "sync_entity_type" NOT NULL,
    "entity_id" UUID NOT NULL,
    "sync_rev" BIGINT NOT NULL,
    "deleted_at" TIMESTAMPTZ(6) NOT NULL,
    "purged_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_tombstones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goals" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "goal_type" "goal_type" NOT NULL DEFAULT 'custom',
    "target_amount_paise" BIGINT NOT NULL,
    "current_amount_paise" BIGINT NOT NULL DEFAULT 0,
    "start_date" DATE NOT NULL,
    "target_date" DATE NOT NULL,
    "priority" SMALLINT NOT NULL DEFAULT 100,
    "expected_return_rate_micro" INTEGER NOT NULL DEFAULT 120000,
    "monthly_contribution_paise" BIGINT NOT NULL DEFAULT 0,
    "status" "goal_status" NOT NULL DEFAULT 'active',
    "source_calculation_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_contributions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "goal_id" UUID NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "contributed_on" DATE NOT NULL,
    "source" "contribution_source" NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "goal_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "category_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "category_kind" NOT NULL DEFAULT 'discretionary',
    "icon_key" TEXT NOT NULL DEFAULT 'category',
    "color_hex" CHAR(7) NOT NULL DEFAULT '#607D8B',
    "sort_order" SMALLINT NOT NULL DEFAULT 500,
    "parent_id" UUID,
    "is_system" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budgets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "period_month" DATE NOT NULL,
    "income_paise" BIGINT NOT NULL DEFAULT 0,
    "planned_savings_paise" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT,
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_categories" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "budget_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "allocated_paise" BIGINT NOT NULL DEFAULT 0,
    "rollover_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" SMALLINT NOT NULL DEFAULT 500,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "budget_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "budget_id" UUID,
    "category_id" UUID NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "txn_type" "txn_type" NOT NULL DEFAULT 'expense',
    "source" "txn_source" NOT NULL DEFAULT 'manual',
    "note" TEXT NOT NULL DEFAULT '',
    "occurred_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "pk_transactions" PRIMARY KEY ("occurred_on","id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "asset_class" "asset_class" NOT NULL,
    "current_value_paise" BIGINT NOT NULL DEFAULT 0,
    "as_of_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_liquid" BOOLEAN NOT NULL DEFAULT false,
    "institution" TEXT,
    "linked_goal_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_valuations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "value_paise" BIGINT NOT NULL,
    "valued_on" DATE NOT NULL,
    "source" "valuation_source" NOT NULL DEFAULT 'user',
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "asset_valuations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liabilities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "liability_type" "liability_type" NOT NULL,
    "outstanding_paise" BIGINT NOT NULL DEFAULT 0,
    "interest_rate_micro" INTEGER NOT NULL DEFAULT 0,
    "as_of_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_loan_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "liabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loans" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "loan_type" "loan_type" NOT NULL,
    "lender_name" TEXT NOT NULL DEFAULT '',
    "principal_paise" BIGINT NOT NULL,
    "interest_rate_micro" INTEGER NOT NULL,
    "tenure_months" SMALLINT NOT NULL,
    "start_date" DATE NOT NULL,
    "emi_day" SMALLINT NOT NULL DEFAULT 5,
    "emi_paise" BIGINT NOT NULL,
    "outstanding_paise" BIGINT NOT NULL,
    "prepayment_total_paise" BIGINT NOT NULL DEFAULT 0,
    "status" "loan_status" NOT NULL DEFAULT 'active',
    "source_calculation_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_payments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "instalment_no" SMALLINT,
    "due_date" DATE NOT NULL,
    "paid_on" DATE,
    "amount_paise" BIGINT NOT NULL,
    "principal_paise" BIGINT NOT NULL DEFAULT 0,
    "interest_paise" BIGINT NOT NULL DEFAULT 0,
    "status" "loan_payment_status" NOT NULL DEFAULT 'scheduled',
    "is_prepayment" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "loan_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_funds" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "monthly_essential_paise" BIGINT NOT NULL DEFAULT 0,
    "dependants" SMALLINT NOT NULL DEFAULT 0,
    "income_stability" "income_stability" NOT NULL DEFAULT 'salaried_stable',
    "target_months" SMALLINT NOT NULL DEFAULT 6,
    "current_corpus_paise" BIGINT NOT NULL DEFAULT 0,
    "monthly_funding_paise" BIGINT NOT NULL DEFAULT 0,
    "linked_goal_id" UUID,
    "essentials_auto_derived" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "emergency_funds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retirement_plans" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'My retirement',
    "current_age" SMALLINT NOT NULL,
    "retirement_age" SMALLINT NOT NULL,
    "life_expectancy" SMALLINT NOT NULL DEFAULT 85,
    "current_corpus_paise" BIGINT NOT NULL DEFAULT 0,
    "monthly_contribution_paise" BIGINT NOT NULL DEFAULT 0,
    "pre_return_rate_micro" INTEGER NOT NULL DEFAULT 120000,
    "post_return_rate_micro" INTEGER NOT NULL DEFAULT 70000,
    "inflation_rate_micro" INTEGER NOT NULL DEFAULT 60000,
    "desired_monthly_income_paise" BIGINT NOT NULL DEFAULT 0,
    "epf_balance_paise" BIGINT NOT NULL DEFAULT 0,
    "nps_balance_paise" BIGINT NOT NULL DEFAULT 0,
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "retirement_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "net_worth_snapshots" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "assets_paise" BIGINT NOT NULL,
    "liabilities_paise" BIGINT NOT NULL,
    "net_worth_paise" BIGINT NOT NULL,
    "liquid_paise" BIGINT NOT NULL DEFAULT 0,
    "composition" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "net_worth_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_snapshots" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "period" "snapshot_period" NOT NULL DEFAULT 'month',
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "income_paise" BIGINT NOT NULL DEFAULT 0,
    "expense_paise" BIGINT NOT NULL DEFAULT 0,
    "essential_paise" BIGINT NOT NULL DEFAULT 0,
    "discretionary_paise" BIGINT NOT NULL DEFAULT 0,
    "savings_paise" BIGINT NOT NULL DEFAULT 0,
    "emi_outflow_paise" BIGINT NOT NULL DEFAULT 0,
    "investment_paise" BIGINT NOT NULL DEFAULT 0,
    "category_breakdown" JSONB NOT NULL DEFAULT '{}',
    "txn_count" INTEGER NOT NULL DEFAULT 0,
    "data_completeness_pct" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_scores" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "scored_on" DATE NOT NULL,
    "score" SMALLINT NOT NULL,
    "band" "health_band" NOT NULL,
    "raw_score" SMALLINT NOT NULL,
    "coverage_pct" SMALLINT NOT NULL,
    "components" JSONB NOT NULL,
    "fact_snapshot_id" UUID,
    "ruleset_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advisor_rules" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "rule_key" TEXT NOT NULL,
    "module_key" TEXT NOT NULL,
    "title_template" TEXT NOT NULL,
    "body_template" TEXT NOT NULL,
    "severity" "recommendation_severity" NOT NULL DEFAULT 'suggested',
    "status" "rule_status" NOT NULL DEFAULT 'draft',
    "priority" SMALLINT NOT NULL DEFAULT 100,
    "impact_weight" SMALLINT NOT NULL DEFAULT 50,
    "actionability" SMALLINT NOT NULL DEFAULT 50,
    "exclusion_group" TEXT,
    "cooldown_days" SMALLINT NOT NULL DEFAULT 30,
    "required_facts" TEXT[],
    "condition" JSONB NOT NULL,
    "cta" JSONB NOT NULL DEFAULT '{}',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "advisor_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advisor_rule_versions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "rule_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "condition" JSONB NOT NULL,
    "title_template" TEXT NOT NULL,
    "body_template" TEXT NOT NULL,
    "severity" "recommendation_severity" NOT NULL,
    "changed_by" TEXT NOT NULL,
    "change_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advisor_rule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advisor_recommendations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "severity" "recommendation_severity" NOT NULL,
    "status" "recommendation_status" NOT NULL DEFAULT 'active',
    "rank_score" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "cited_facts" JSONB NOT NULL DEFAULT '{}',
    "cta" JSONB NOT NULL DEFAULT '{}',
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "dismissed_at" TIMESTAMPTZ(6),
    "snoozed_until" TIMESTAMPTZ(6),
    "actioned_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "advisor_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "recommendation_id" UUID NOT NULL,
    "event_type" "recommendation_event_type" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "recommendation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_health_inputs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "active_loan_count" SMALLINT NOT NULL DEFAULT 0,
    "credit_card_count" SMALLINT NOT NULL DEFAULT 0,
    "total_card_limit_paise" BIGINT NOT NULL DEFAULT 0,
    "total_card_balance_paise" BIGINT NOT NULL DEFAULT 0,
    "missed_payments_12m" SMALLINT NOT NULL DEFAULT 0,
    "oldest_account_months" SMALLINT NOT NULL DEFAULT 0,
    "recent_enquiries_6m" SMALLINT NOT NULL DEFAULT 0,
    "has_secured_loan" BOOLEAN NOT NULL DEFAULT false,
    "self_reported_at" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "credit_health_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_health_assessments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "input_id" UUID,
    "band" "credit_rating_band" NOT NULL,
    "factors" JSONB NOT NULL DEFAULT '[]',
    "risk_flags" TEXT[],
    "suggestions" JSONB NOT NULL DEFAULT '[]',
    "rubric_version" TEXT NOT NULL,
    "assessed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_health_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "event_type" "calendar_event_type" NOT NULL,
    "title" TEXT NOT NULL,
    "amount_paise" BIGINT,
    "due_on" DATE NOT NULL,
    "recurrence" "recurrence_freq" NOT NULL DEFAULT 'once',
    "recurrence_until" DATE,
    "status" "calendar_event_status" NOT NULL DEFAULT 'scheduled',
    "remind_days_before" SMALLINT NOT NULL DEFAULT 1,
    "source_loan_id" UUID,
    "source_goal_id" UUID,
    "is_auto" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_tokens" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "fcm_token" TEXT NOT NULL,
    "platform" "device_platform" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMPTZ(6),
    "failure_count" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "channel" "notification_channel" NOT NULL DEFAULT 'push',
    "status" "notification_status" NOT NULL DEFAULT 'queued',
    "template_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "dedupe_key" TEXT,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_categories" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "category_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon_key" TEXT NOT NULL DEFAULT 'school',
    "sort_order" SMALLINT NOT NULL DEFAULT 500,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "learning_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_articles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "category_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "body_markdown" TEXT NOT NULL,
    "read_minutes" SMALLINT NOT NULL DEFAULT 3,
    "status" "article_status" NOT NULL DEFAULT 'draft',
    "locale" TEXT NOT NULL DEFAULT 'en_IN',
    "content_version" INTEGER NOT NULL DEFAULT 1,
    "related_module_key" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "learning_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_progress" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "status" "learning_status" NOT NULL DEFAULT 'unread',
    "progress_pct" SMALLINT NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "learning_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_calculations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "calculator_key" TEXT NOT NULL,
    "label" TEXT,
    "inputs" JSONB NOT NULL,
    "outputs" JSONB NOT NULL,
    "engine_version" TEXT NOT NULL,
    "ruleset_version" TEXT,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "sync_rev" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "saved_calculations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "report_type" "report_type" NOT NULL,
    "status" "report_status" NOT NULL DEFAULT 'queued',
    "period_start" DATE,
    "period_end" DATE,
    "params" JSONB NOT NULL DEFAULT '{}',
    "payload" JSONB,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_artifacts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "report_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "artifact_kind" NOT NULL DEFAULT 'pdf',
    "storage_path" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "platform" "subscription_platform" NOT NULL DEFAULT 'google_play',
    "product_id" TEXT NOT NULL,
    "purchase_token" TEXT,
    "order_id" TEXT,
    "status" "subscription_status" NOT NULL DEFAULT 'pending_verification',
    "current_period_start" TIMESTAMPTZ(6),
    "current_period_end" TIMESTAMPTZ(6),
    "auto_renewing" BOOLEAN NOT NULL DEFAULT true,
    "cancelled_at" TIMESTAMPTZ(6),
    "last_verified_at" TIMESTAMPTZ(6),
    "raw_notification" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlements" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "feature_key" TEXT NOT NULL,
    "source" "entitlement_source" NOT NULL DEFAULT 'subscription',
    "subscription_id" UUID,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "flag_key" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "rollout_pct" SMALLINT NOT NULL DEFAULT 0,
    "target_rule" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rulesets" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "fy_label" TEXT NOT NULL,
    "ruleset_key" TEXT NOT NULL,
    "status" "ruleset_status" NOT NULL DEFAULT 'draft',
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "ruleset" JSONB NOT NULL,
    "checksum" BYTEA NOT NULL,
    "source_note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tax_rulesets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_rates" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "rate_kind" "rate_kind" NOT NULL,
    "code" TEXT NOT NULL,
    "rate" DECIMAL(9,6) NOT NULL,
    "as_of" DATE NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actor_type" "audit_actor_type" NOT NULL DEFAULT 'user',
    "actor_id" UUID,
    "subject_hash" BYTEA,
    "action" TEXT NOT NULL,
    "entity_table" TEXT,
    "entity_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "request_id" TEXT,
    "ip_prefix" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_user_id_key" ON "user_profiles"("user_id");

-- CreateIndex
CREATE INDEX "ix_user_profiles__sync" ON "user_profiles"("user_id", "sync_rev");

-- CreateIndex
CREATE UNIQUE INDEX "ux_user_devices__user_device" ON "user_devices"("user_id", "device_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_refresh_tokens__hash" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "ix_refresh_tokens__family" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "ix_refresh_tokens__cleanup" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "ix_auth_audit_log__user_time" ON "auth_audit_log"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_auth_audit_log__event_time" ON "auth_audit_log"("event", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_sync_tombstones__pull" ON "sync_tombstones"("user_id", "sync_rev");

-- CreateIndex
CREATE UNIQUE INDEX "ux_sync_tombstones__entity" ON "sync_tombstones"("user_id", "entity_table", "entity_id");

-- CreateIndex
CREATE INDEX "ix_goals__user_live" ON "goals"("user_id", "priority", "id");

-- CreateIndex
CREATE INDEX "ix_goals__user_status" ON "goals"("user_id", "status");

-- CreateIndex
CREATE INDEX "ix_goals__user_sync" ON "goals"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_goals__target_date" ON "goals"("user_id", "target_date");

-- CreateIndex
CREATE INDEX "ix_goal_contributions__goal_date" ON "goal_contributions"("goal_id", "contributed_on" DESC);

-- CreateIndex
CREATE INDEX "ix_goal_contributions__user_sync" ON "goal_contributions"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_expense_categories__user_sort" ON "expense_categories"("user_id", "sort_order");

-- CreateIndex
CREATE INDEX "ix_expense_categories__user_sync" ON "expense_categories"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_budgets__user_sync" ON "budgets"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_budget_categories__user_sync" ON "budget_categories"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_transactions__user_month" ON "transactions"("user_id", "occurred_on" DESC);

-- CreateIndex
CREATE INDEX "ix_transactions__user_cat_month" ON "transactions"("user_id", "category_id", "occurred_on");

-- CreateIndex
CREATE INDEX "ix_transactions__user_sync" ON "transactions"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_transactions__budget" ON "transactions"("budget_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_transactions__id" ON "transactions"("id");

-- CreateIndex
CREATE INDEX "ix_assets__user_live" ON "assets"("user_id", "asset_class");

-- CreateIndex
CREATE INDEX "ix_assets__user_sync" ON "assets"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_asset_valuations__user_sync" ON "asset_valuations"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_liabilities__user_live" ON "liabilities"("user_id", "liability_type");

-- CreateIndex
CREATE INDEX "ix_liabilities__user_sync" ON "liabilities"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_loans__user_live" ON "loans"("user_id", "status");

-- CreateIndex
CREATE INDEX "ix_loans__user_sync" ON "loans"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_loan_payments__loan_due" ON "loan_payments"("loan_id", "due_date");

-- CreateIndex
CREATE INDEX "ix_loan_payments__user_sync" ON "loan_payments"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_loan_payments__overdue" ON "loan_payments"("user_id", "due_date");

-- CreateIndex
CREATE INDEX "ix_emergency_funds__user_sync" ON "emergency_funds"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_retirement_plans__user_sync" ON "retirement_plans"("user_id", "sync_rev");

-- CreateIndex
CREATE UNIQUE INDEX "ux_nws__user_date" ON "net_worth_snapshots"("user_id", "snapshot_date");

-- CreateIndex
CREATE INDEX "ix_fs__user_recent" ON "financial_snapshots"("user_id", "period", "period_start" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ux_fs__user_period" ON "financial_snapshots"("user_id", "period", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "ux_hs__user_date" ON "health_scores"("user_id", "scored_on");

-- CreateIndex
CREATE UNIQUE INDEX "ux_advisor_rules__key" ON "advisor_rules"("rule_key");

-- CreateIndex
CREATE INDEX "ix_advisor_rules__active" ON "advisor_rules"("module_key", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "ux_arv__rule_version" ON "advisor_rule_versions"("rule_id", "version");

-- CreateIndex
CREATE INDEX "ix_ar__cooldown" ON "advisor_recommendations"("user_id", "rule_id", "generated_at" DESC);

-- CreateIndex
CREATE INDEX "ix_re__rec_type" ON "recommendation_events"("recommendation_id", "event_type");

-- CreateIndex
CREATE INDEX "ix_re__user_sync" ON "recommendation_events"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_re__type_time" ON "recommendation_events"("event_type", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "ix_chi__user_sync" ON "credit_health_inputs"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_cha__user_time" ON "credit_health_assessments"("user_id", "assessed_at" DESC);

-- CreateIndex
CREATE INDEX "ix_ce__user_due" ON "calendar_events"("user_id", "due_on");

-- CreateIndex
CREATE INDEX "ix_ce__user_sync" ON "calendar_events"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_ce__auto_source" ON "calendar_events"("source_loan_id", "due_on");

-- CreateIndex
CREATE UNIQUE INDEX "ux_nt__token" ON "notification_tokens"("fcm_token");

-- CreateIndex
CREATE INDEX "ix_notif__due" ON "notifications"("scheduled_for");

-- CreateIndex
CREATE INDEX "ix_notif__user_feed" ON "notifications"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ux_lc__key" ON "learning_categories"("category_key");

-- CreateIndex
CREATE UNIQUE INDEX "ux_la__slug_locale" ON "learning_articles"("slug", "locale");

-- CreateIndex
CREATE INDEX "ix_lp__user_sync" ON "learning_progress"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_sc__user_recent" ON "saved_calculations"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_sc__user_kind" ON "saved_calculations"("user_id", "calculator_key", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_sc__user_sync" ON "saved_calculations"("user_id", "sync_rev");

-- CreateIndex
CREATE INDEX "ix_reports__user_recent" ON "reports"("user_id", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "ix_reports__queue" ON "reports"("status", "requested_at");

-- CreateIndex
CREATE INDEX "ix_ra__report" ON "report_artifacts"("report_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_subs__purchase_token" ON "subscriptions"("purchase_token");

-- CreateIndex
CREATE INDEX "ix_subs__user_status" ON "subscriptions"("user_id", "status");

-- CreateIndex
CREATE INDEX "ix_subs__expiring" ON "subscriptions"("current_period_end");

-- CreateIndex
CREATE UNIQUE INDEX "ux_ff__key" ON "feature_flags"("flag_key");

-- CreateIndex
CREATE UNIQUE INDEX "ux_tr__key" ON "tax_rulesets"("ruleset_key");

-- CreateIndex
CREATE INDEX "ix_rr__latest" ON "reference_rates"("rate_kind", "code", "as_of" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ux_rr__kind_code_date" ON "reference_rates"("rate_kind", "code", "as_of");

-- CreateIndex
CREATE INDEX "ix_audit__subject_time" ON "audit_log"("subject_hash", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_audit__entity" ON "audit_log"("entity_table", "entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_audit__action_time" ON "audit_log"("action", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "user_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_tombstones" ADD CONSTRAINT "sync_tombstones_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_source_calculation_id_fkey" FOREIGN KEY ("source_calculation_id") REFERENCES "saved_calculations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "expense_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_categories" ADD CONSTRAINT "budget_categories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_categories" ADD CONSTRAINT "budget_categories_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_categories" ADD CONSTRAINT "budget_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_linked_goal_id_fkey" FOREIGN KEY ("linked_goal_id") REFERENCES "goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_valuations" ADD CONSTRAINT "asset_valuations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_valuations" ADD CONSTRAINT "asset_valuations_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liabilities" ADD CONSTRAINT "liabilities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liabilities" ADD CONSTRAINT "liabilities_source_loan_id_fkey" FOREIGN KEY ("source_loan_id") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_source_calculation_id_fkey" FOREIGN KEY ("source_calculation_id") REFERENCES "saved_calculations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_funds" ADD CONSTRAINT "emergency_funds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_funds" ADD CONSTRAINT "emergency_funds_linked_goal_id_fkey" FOREIGN KEY ("linked_goal_id") REFERENCES "goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retirement_plans" ADD CONSTRAINT "retirement_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "net_worth_snapshots" ADD CONSTRAINT "net_worth_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_snapshots" ADD CONSTRAINT "financial_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_scores" ADD CONSTRAINT "health_scores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_scores" ADD CONSTRAINT "health_scores_fact_snapshot_id_fkey" FOREIGN KEY ("fact_snapshot_id") REFERENCES "financial_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advisor_rule_versions" ADD CONSTRAINT "advisor_rule_versions_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "advisor_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advisor_recommendations" ADD CONSTRAINT "advisor_recommendations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advisor_recommendations" ADD CONSTRAINT "advisor_recommendations_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "advisor_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "advisor_recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_health_inputs" ADD CONSTRAINT "credit_health_inputs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_health_assessments" ADD CONSTRAINT "credit_health_assessments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_health_assessments" ADD CONSTRAINT "credit_health_assessments_input_id_fkey" FOREIGN KEY ("input_id") REFERENCES "credit_health_inputs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_source_loan_id_fkey" FOREIGN KEY ("source_loan_id") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_source_goal_id_fkey" FOREIGN KEY ("source_goal_id") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_tokens" ADD CONSTRAINT "notification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_tokens" ADD CONSTRAINT "notification_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "user_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_articles" ADD CONSTRAINT "learning_articles_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "learning_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_progress" ADD CONSTRAINT "learning_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_progress" ADD CONSTRAINT "learning_progress_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "learning_articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_calculations" ADD CONSTRAINT "saved_calculations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_artifacts" ADD CONSTRAINT "report_artifacts_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_artifacts" ADD CONSTRAINT "report_artifacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

