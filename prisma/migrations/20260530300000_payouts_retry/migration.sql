-- PAY-005: payouts retry/backoff polish.
--
-- Additive only. The payouts table from PAY-001 was sized for the dispatcher
-- happy-path (QUEUED → PROCESSING → SUCCEEDED / FAILED / CANCELLED). PAY-005
-- adds the retry machinery the spec mandates (gearsh-payments-engine.md
-- §Jobs: every-4-hour retry; business-rules §8.1 dispute-window dispatcher).
--
--   1. payouts ← attempts INT NOT NULL DEFAULT 0
--      Bumped by the retry job each time it re-queues a FAILED row. The
--      dispatcher uses NULL → 0 default; the retry job stops at
--      PAYOUT_MAX_ATTEMPTS (default 5).
--
--   2. payouts ← failed_at TIMESTAMPTZ
--      Set by the dispatcher whenever it flips a row to FAILED. The retry job
--      gates re-queues by `failed_at < NOW() - <backoff hours>` where
--      backoff_hours = min(24, 2 ** attempts). NULL when the row never
--      failed (QUEUED / PROCESSING / SUCCEEDED / CANCELLED).
--
-- pgcrypto is already in the init migration (CREATE EXTENSION at line 1) — no
-- re-create needed here. It backs artist_payout_methods.account_number_encrypted
-- via pgp_sym_encrypt / pgp_sym_decrypt called from
-- src/common/crypto/encryption.service.ts (PAYOUT_METHOD_ENCRYPTION_KEY in
-- AppConfig). The key NEVER leaves Secret Manager (or .env in dev); decryption
-- is only authorised inside the payout dispatcher + admin unmask path.

ALTER TABLE "payouts"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "failed_at" TIMESTAMPTZ(3);

-- Retry job index — locate FAILED rows ready to re-queue without scanning the
-- whole payouts table. The dispatcher index (state, dispatch_after) already
-- exists from PAY-001; this is the retry-side mirror.
CREATE INDEX "payouts_state_failed_at_idx" ON "payouts"("state", "failed_at");
