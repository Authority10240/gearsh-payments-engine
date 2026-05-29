-- PAY-007: nightly reconciliation + admin audit log.
--
-- Two NEW tables, additive only. No existing column or index is altered.
--
--   1. reconciliation_runs
--      One row per nightly reconciliation tick (and per manual admin trigger).
--      Persists invariant + PayFast-drift findings as a single JSONB blob so
--      the run can be re-read by the admin UI without re-running the query.
--      `findings_count` is denormalised for cheap dashboard counts.
--
--   2. admin_audit_log
--      One row per admin HTTP request that reached a resolved subject (i.e.
--      passed the JwtAuthGuard). Written by AdminAuditMiddleware via
--      `setImmediate` so the response is never blocked. Payments did not have
--      this table previously; Data Engine's DATA-010 introduced the same shape
--      and we mirror it 1:1 here.
--
-- Recon state enum is exported so Prisma generates a `ReconciliationRunState`
-- type — the admin UI uses it as the canonical string set.
--
-- Indexes (per ticket §2):
--   admin_audit_log (actor_id, created_at desc) — "what did this admin do?"
--   admin_audit_log (action, created_at desc)   — "show all booking-status overrides"
--   reconciliation_runs (as_of_date desc)       — "list the last N runs"

-- CreateEnum
CREATE TYPE "ReconciliationRunState" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "as_of_date" DATE NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "state" "ReconciliationRunState" NOT NULL DEFAULT 'RUNNING',
    "findings_count" INTEGER NOT NULL DEFAULT 0,
    "findings" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "alert_sent" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reconciliation_runs_as_of_date_idx" ON "reconciliation_runs"("as_of_date" DESC);
CREATE INDEX "reconciliation_runs_created_at_idx" ON "reconciliation_runs"("created_at" DESC);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "target_id" TEXT,
    "request_body" JSONB,
    "response_code" INTEGER,
    "ip" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_audit_log_actor_id_created_at_idx" ON "admin_audit_log"("actor_id", "created_at" DESC);
CREATE INDEX "admin_audit_log_action_created_at_idx" ON "admin_audit_log"("action", "created_at" DESC);
