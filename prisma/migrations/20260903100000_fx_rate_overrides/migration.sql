-- PAY-008: admin FX rate overrides — pinned rates that beat provider rows.
CREATE TABLE "fx_rate_overrides" (
    "from_currency" "Currency" NOT NULL,
    "to_currency" "Currency" NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rate_overrides_pkey" PRIMARY KEY ("from_currency","to_currency")
);
