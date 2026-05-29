-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- UUIDv7 generator (RFC 9562). Postgres 16 has no native uuidv7(); this function
-- is used as the default for every primary key (conventions §2). It composes the
-- 48-bit Unix-millis timestamp prefix with random bits from pgcrypto and sets the
-- version (7) and variant (10) nibbles. Time-sortable, safe as a clustered key.
CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS uuid
AS $$
DECLARE
  unix_ts_ms bytea;
  uuid_bytes bytea;
BEGIN
  unix_ts_ms = substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
  -- 10 random bytes for the remaining entropy.
  uuid_bytes = unix_ts_ms || gen_random_bytes(10);
  -- Set version to 7 (high nibble of byte 7).
  uuid_bytes = set_byte(uuid_bytes, 6, (b'0111' || get_byte(uuid_bytes, 6)::bit(4))::bit(8)::int);
  -- Set variant to 10x (two high bits of byte 9).
  uuid_bytes = set_byte(uuid_bytes, 8, (b'10' || get_byte(uuid_bytes, 8)::bit(6))::bit(8)::int);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('ZAR', 'USD', 'GBP', 'NGN', 'KES', 'GHS', 'AUD', 'CAD');

-- CreateEnum
CREATE TYPE "CartState" AS ENUM ('ACTIVE', 'CHECKED_OUT', 'ABANDONED');

-- CreateEnum
CREATE TYPE "IntentState" AS ENUM ('CREATED', 'LOCKED', 'AWAITING_PAYMENT', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentGateway" AS ENUM ('PAYFAST');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('CHARGE', 'REFUND');

-- CreateEnum
CREATE TYPE "TransactionState" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundState" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "EscrowState" AS ENUM ('HELD', 'RELEASED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "EscrowEventType" AS ENUM ('HELD', 'RELEASED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FROZEN', 'RESOLVED_RELEASE', 'RESOLVED_REFUND');

-- CreateEnum
CREATE TYPE "PayoutState" AS ENUM ('QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LedgerAccount" AS ENUM ('CLIENT_FUNDS', 'ESCROW_LIABILITY', 'PLATFORM_REVENUE', 'ARTIST_PAYABLE', 'PAYFAST_SETTLEMENT', 'REFUNDS_ISSUED');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "BankAccountType" AS ENUM ('CHEQUE', 'SAVINGS', 'TRANSMISSION');

-- CreateEnum
CREATE TYPE "ExchangeRateSource" AS ENUM ('OPEN_EXCHANGE_RATES', 'STUB', 'MANUAL');

-- CreateTable
CREATE TABLE "carts" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "currency" "Currency" NOT NULL,
    "state" "CartState" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "cart_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "artist_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price_cents" BIGINT NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "booking_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "artist_id" UUID NOT NULL,
    "subtotal_cents" BIGINT NOT NULL,
    "service_fee_cents" BIGINT NOT NULL,
    "total_cents" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "client_currency" "Currency" NOT NULL,
    "gateway" "PaymentGateway" NOT NULL DEFAULT 'PAYFAST',
    "pf_payment_id" TEXT,
    "m_payment_id" TEXT,
    "state" "IntentState" NOT NULL DEFAULT 'CREATED',
    "quoted_zar_amount_cents" BIGINT,
    "zar_amount_cents_locked" BIGINT,
    "zar_rate_locked" DECIMAL(18,8),
    "zar_locked_at" TIMESTAMPTZ(3),
    "lock_expires_at" TIMESTAMPTZ(3),
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "payment_intent_id" UUID NOT NULL,
    "type" "TransactionType" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "gateway_txn_id" TEXT,
    "state" "TransactionState" NOT NULL DEFAULT 'PENDING',
    "raw_gateway_payload" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "transaction_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "reason" TEXT,
    "initiated_by" UUID NOT NULL,
    "state" "RefundState" NOT NULL DEFAULT 'PENDING',
    "gateway_refund_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "from_currency" "Currency" NOT NULL,
    "to_currency" "Currency" NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "as_of" TIMESTAMPTZ(3) NOT NULL,
    "source" "ExchangeRateSource" NOT NULL DEFAULT 'STUB',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("from_currency","to_currency","as_of")
);

-- CreateTable
CREATE TABLE "escrow_holds" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "booking_id" UUID NOT NULL,
    "payment_intent_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "artist_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "platform_fee_cents" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "state" "EscrowState" NOT NULL DEFAULT 'HELD',
    "held_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(3),
    "refunded_at" TIMESTAMPTZ(3),
    "disputed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "escrow_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escrow_events" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "hold_id" UUID NOT NULL,
    "type" "EscrowEventType" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "actor_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escrow_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "hold_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "account" "LedgerAccount" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "artist_id" UUID NOT NULL,
    "hold_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "state" "PayoutState" NOT NULL DEFAULT 'QUEUED',
    "dispatch_after" TIMESTAMPTZ(3) NOT NULL,
    "gateway_payout_id" TEXT,
    "attempted_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancellation_reason" TEXT,
    "failure_reason" TEXT,
    "raw_gateway_payload" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artist_payout_methods" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "artist_user_id" UUID NOT NULL,
    "bank_name" TEXT NOT NULL,
    "account_holder_name" TEXT NOT NULL,
    "account_number_encrypted" BYTEA NOT NULL,
    "branch_code" TEXT NOT NULL,
    "account_type" "BankAccountType" NOT NULL,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMPTZ(3),
    "verified_by" UUID,
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "artist_payout_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "consumer_name" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id","consumer_name")
);

-- CreateIndex
CREATE INDEX "carts_user_id_idx" ON "carts"("user_id");

-- CreateIndex
CREATE INDEX "cart_items_cart_id_idx" ON "cart_items"("cart_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_booking_id_key" ON "payment_intents"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_m_payment_id_key" ON "payment_intents"("m_payment_id");

-- CreateIndex
CREATE INDEX "payment_intents_user_id_idx" ON "payment_intents"("user_id");

-- CreateIndex
CREATE INDEX "payment_intents_artist_id_idx" ON "payment_intents"("artist_id");

-- CreateIndex
CREATE INDEX "payment_intents_state_idx" ON "payment_intents"("state");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_idempotency_key_key" ON "payment_intents"("idempotency_key");

-- CreateIndex
CREATE INDEX "transactions_payment_intent_id_idx" ON "transactions"("payment_intent_id");

-- CreateIndex
CREATE INDEX "transactions_gateway_txn_id_idx" ON "transactions"("gateway_txn_id");

-- CreateIndex
CREATE INDEX "refunds_transaction_id_idx" ON "refunds"("transaction_id");

-- CreateIndex
CREATE INDEX "exchange_rates_from_currency_to_currency_as_of_idx" ON "exchange_rates"("from_currency", "to_currency", "as_of" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "escrow_holds_booking_id_key" ON "escrow_holds"("booking_id");

-- CreateIndex
CREATE INDEX "escrow_holds_artist_id_idx" ON "escrow_holds"("artist_id");

-- CreateIndex
CREATE INDEX "escrow_holds_state_idx" ON "escrow_holds"("state");

-- CreateIndex
CREATE INDEX "escrow_events_hold_id_idx" ON "escrow_events"("hold_id");

-- CreateIndex
CREATE INDEX "ledger_entries_hold_id_idx" ON "ledger_entries"("hold_id");

-- CreateIndex
CREATE INDEX "ledger_entries_event_id_idx" ON "ledger_entries"("event_id");

-- CreateIndex
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries"("account");

-- CreateIndex
CREATE INDEX "payouts_artist_id_idx" ON "payouts"("artist_id");

-- CreateIndex
CREATE INDEX "payouts_state_dispatch_after_idx" ON "payouts"("state", "dispatch_after");

-- CreateIndex
CREATE UNIQUE INDEX "artist_payout_methods_artist_user_id_key" ON "artist_payout_methods"("artist_user_id");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_idx" ON "outbox_events"("published_at");

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escrow_holds" ADD CONSTRAINT "escrow_holds_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escrow_events" ADD CONSTRAINT "escrow_events_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "escrow_holds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "escrow_holds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "escrow_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "escrow_holds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
