-- PAY-002: PayFast ITN webhook + atomic escrow.held.
--
-- Two additive changes:
--
--   1. payment_intents.zar_service_fee_cents_locked
--      The ZAR-denominated platform fee at the locked rate. The escrow hold
--      stores amount_cents = zar_amount_cents_locked - zar_service_fee_cents_locked
--      (business-rules §8.5: the fee is recognised as PLATFORM_REVENUE at
--      escrow.held; the hold is the *net* available for release/refund).
--
--   2. transactions: pf_payment_status column + composite unique
--      (payment_intent_id, gateway_txn_id, pf_payment_status). PayFast retries
--      ITN posts until acknowledged with 200; the webhook treats a row with
--      this tuple already present as duplicate and short-circuits (PAY-002
--      §3 idempotency). Distinct statuses for the same pf_payment_id (rare —
--      e.g. a PENDING followed by a COMPLETE) are persisted as separate rows.

-- 1) Intent FX-lock fee column. Nullable: pre-PAY-002 LOCKED intents remain
--    valid; the webhook will COMPUTE this on the fly when null.
ALTER TABLE "payment_intents"
  ADD COLUMN "zar_service_fee_cents_locked" BIGINT;

-- 2) Transaction ITN dedup. Postgres treats NULL values in a UNIQUE index as
--    distinct, so pre-PAY-002 rows (pf_payment_status IS NULL) do not collide
--    with new ITN rows.
CREATE TYPE "PayFastPaymentStatus" AS ENUM ('COMPLETE', 'FAILED', 'PENDING', 'CANCELLED');

ALTER TABLE "transactions"
  ADD COLUMN "pf_payment_status" "PayFastPaymentStatus";

CREATE UNIQUE INDEX "transactions_payment_intent_id_gateway_txn_id_pf_payment_status_key"
  ON "transactions"("payment_intent_id", "gateway_txn_id", "pf_payment_status");
