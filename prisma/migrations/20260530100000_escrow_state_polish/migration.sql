-- PAY-003: escrow state machine + double-entry ledger polish.
--
-- Additive only. Two narrow shape changes drive PARTIALLY_REFUNDED accounting
-- + the future PAY-004 refunds FK plumbing.
--
--   1. escrow_holds.partially_refunded_amount_cents
--      Running total of refunded cents on a hold while it sits in
--      PARTIALLY_REFUNDED. The state machine increments this on each
--      partial-refund event and reads it on the release-remainder transition
--      so the artist payout is (amount_cents - partially_refunded_amount_cents).
--      Defaults to 0 so existing PAY-002 HELD rows backfill cleanly.
--
--   2. escrow_events.refund_id
--      Forward-compat link to the future `refunds` table. PAY-004 will own the
--      Refund row + the PayFast Refund API call; PAY-003 only writes the column
--      as NULL. No FK constraint yet — PAY-004 will add it once `refunds` is
--      wired to escrow (today it's keyed on `transactions`).

ALTER TABLE "escrow_holds"
  ADD COLUMN "partially_refunded_amount_cents" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "escrow_events"
  ADD COLUMN "refund_id" UUID;

-- Helpful index for nightly reconciliation (PAY-007) — locate every event tied
-- to a given refund without scanning the whole audit log.
CREATE INDEX "escrow_events_refund_id_idx" ON "escrow_events"("refund_id");
