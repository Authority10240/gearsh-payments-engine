-- PAY-004: refunds API polish.
--
-- Additive only. Three narrow shape changes that turn the placeholder `refunds`
-- table (PAY-001 init) into the operational store for the PayFast Refund API
-- round-trip:
--
--   1. RefundState ← PROCESSING.
--      PAY-004 inserts the row in PROCESSING before the gateway call. PENDING
--      is retained for back-compat (no new writes use it).
--
--   2. refunds ← gateway_response_payload jsonb, failure_reason text,
--      completed_at timestamptz.
--      RefundsService captures the raw PayFast response (success or failure),
--      stamps completed_at on SUCCEEDED, and records the failure reason on
--      FAILED. Read by the nightly reconciliation report (PAY-007) and the
--      admin UI.
--
--   3. escrow_events.refund_id FK → refunds(id) ON DELETE SET NULL.
--      The column was added in PAY-003 with NO constraint because the refunds
--      table was still a placeholder. PAY-004 owns the refund row + sets the
--      column from RefundsService.issueRefund() inside the same Prisma
--      transaction as the escrow state flip. The FK is enforceable now.

-- Enum widen — add PROCESSING. ALTER TYPE ... ADD VALUE is non-transactional in
-- Postgres; it's safe because we don't read the new value in the same migration.
ALTER TYPE "RefundState" ADD VALUE IF NOT EXISTS 'PROCESSING';

-- Refund row polish.
ALTER TABLE "refunds"
  ADD COLUMN "gateway_response_payload" JSONB,
  ADD COLUMN "failure_reason" TEXT,
  ADD COLUMN "completed_at" TIMESTAMPTZ(3);

-- Index on state for the admin list filter (state=PROCESSING / FAILED).
CREATE INDEX "refunds_state_idx" ON "refunds"("state");

-- FK on escrow_events.refund_id. ON DELETE SET NULL so a malformed refund row
-- can be pruned without losing the escrow audit trail (the ledger entries on
-- the same escrow_event remain valid; only the back-reference is cleared).
ALTER TABLE "escrow_events"
  ADD CONSTRAINT "escrow_events_refund_id_fkey"
  FOREIGN KEY ("refund_id") REFERENCES "refunds"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
