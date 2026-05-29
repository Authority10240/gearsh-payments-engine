import { z } from 'zod';

/**
 * Boot-time environment schema (conventions §20: engine refuses to start on
 * invalid config). Validates the raw process.env; the structured, typed
 * configuration object is assembled in configuration.ts.
 *
 * The Payments Engine VERIFIES platform JWTs only (mirrors data engine —
 * no private key, no JWKS). PayFast + Open Exchange Rates env vars are all
 * OPTIONAL so the engine boots in dev/CI without creds; the corresponding
 * clients degrade to 503 PAYFAST_UPSTREAM_FAILURE / FX_RATE_UNAVAILABLE
 * until creds are provisioned (business-rules §8.4, §8.8).
 */
const booleanish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(8020),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    SERVICE_NAME: z.string().default('gearsh-payments-engine'),

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),

    // Platform JWT verification — inline PEM or a file path (resolved in
    // configuration.ts). This engine verifies only; no private key.
    JWT_PUBLIC_KEY: z.string().optional(),
    JWT_PUBLIC_KEY_FILE: z.string().optional(),
    JWT_ISSUER: z.string().default('gearsh-auth'),
    JWT_AUDIENCE: z.string().default('gearsh-platform'),

    // Internal service-to-service calls (Data → Payments on booking create).
    AUTH_SERVICE_URL: z.string().url().optional(),
    DATA_SERVICE_URL: z.string().url().optional(),
    INTERNAL_JWT_AUDIENCE: z.string().default('gearsh-platform-internal'),
    /**
     * Optional shared secret accepted on internal calls in addition to a
     * signed internal JWT. Useful for local dev where the data engine
     * isn't issuing internal tokens yet.
     */
    INTERNAL_SERVICE_TOKEN: z.string().optional(),

    // Business rules
    SERVICE_FEE_PERCENT: z.coerce.number().min(0).max(100).default(12.6),
    DISPUTE_WINDOW_DAYS: z.coerce.number().int().min(0).default(7),
    FX_INTENT_LOCK_TTL_MINUTES: z.coerce.number().int().min(1).default(15),

    // PayFast — all optional (degrade-on-missing-creds, business-rules §8.8).
    PAYFAST_MERCHANT_ID: z.string().optional(),
    PAYFAST_MERCHANT_KEY: z.string().optional(),
    PAYFAST_PASSPHRASE: z.string().optional(),
    PAYFAST_SANDBOX: booleanish.optional(),
    PAYFAST_PROCESS_URL: z.string().url().optional(),
    PAYFAST_VALIDATE_URL: z.string().url().optional(),
    PAYFAST_RETURN_URL: z.string().url().optional(),
    PAYFAST_CANCEL_URL: z.string().url().optional(),
    PAYFAST_NOTIFY_URL: z.string().url().optional(),
    PAYFAST_REFUND_URL: z.string().optional(),
    PAYFAST_ADHOC_PAYMENT_URL: z.string().url().optional(),
    PAYFAST_IP_WHITELIST: z.string().default(''),

    // FX provider (Open Exchange Rates) — optional; stub used when blank.
    EXCHANGE_RATE_PROVIDER: z.enum(['open_exchange_rates', 'stub']).default('open_exchange_rates'),
    EXCHANGE_RATE_PROVIDER_URL: z.string().url().optional(),
    EXCHANGE_RATE_PROVIDER_KEY: z.string().optional(),

    // pgcrypto symmetric key for artist_payout_methods.account_number_encrypted.
    PAYOUT_METHOD_ENCRYPTION_KEY: z.string().min(16),

    // Payout dispatcher / retry — env-gated for tests + ops (PAY-005, mirrors
    // the FX cron pattern). Default ON so production cron is active without
    // extra config; tests flip these to false to avoid the hourly tick
    // racing with seed data.
    PAYOUT_DISPATCH_ENABLED: booleanish.optional(),
    PAYOUT_RETRY_ENABLED: booleanish.optional(),
    // Max attempts before the retry job stops re-queueing a FAILED payout
    // (gearsh-payments-engine.md §Jobs: "5 attempts over 24h").
    PAYOUT_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
    // Bounded batch — the dispatcher picks at most this many QUEUED rows per
    // tick so a backlog can't starve other DB work.
    PAYOUT_DISPATCH_BATCH_SIZE: z.coerce.number().int().min(1).default(50),

    // Reconciliation (PAY-007). The cron itself is env-gated so tests can
    // disable it cleanly (`RECONCILIATION_ENABLED=false`); the per-run alert
    // threshold caps Σ ledger drift below which the run still passes (default
    // R10.00 == 1000 cents per spec §Reconciliation).
    RECONCILIATION_ENABLED: booleanish.optional(),
    RECONCILIATION_ALERT_THRESHOLD_CENTS: z.coerce.number().int().min(0).default(1000),
    RECONCILIATION_ALERT_EMAIL: z.string().optional(),
    // Stuck-state thresholds surfaced by /v1/admin/reconciliation/stuck/* —
    // pragmatic env knobs (PAY-006 enumerated the watch list).
    STUCK_HOLD_HOURS: z.coerce.number().int().min(1).default(72),
    STUCK_PAYOUT_HOURS: z.coerce.number().int().min(1).default(24),
    STUCK_DISPUTE_DAYS: z.coerce.number().int().min(1).default(14),

    // Subscriber-driven actor id (PAY-006). Stamped onto refunds.initiated_by
    // when bookings.cancelled / disputes.resolved trigger a RefundsService
    // call from a Pub/Sub message rather than an admin HTTP request. Defaults
    // to the all-zeros UUID for dev/CI so the engine boots without extra
    // config; production overrides via Secret Manager.
    SYSTEM_USER_ID: z.string().uuid().default('00000000-0000-0000-0000-000000000000'),

    // Pub/Sub
    PUBSUB_PROJECT_ID: z.string().optional(),
    PUBSUB_PUBLISH_TOPICS: z.string().default('payment-events,escrow-events'),
    PUBSUB_SUBSCRIPTIONS: z
      .string()
      .default('payments-sub-booking-events,payments-sub-dispute-events'),
    PUBSUB_EMULATOR_HOST: z.string().optional(),
    PUBSUB_ENABLED: booleanish.optional(),

    // CORS / rate limit
    CORS_ALLOWED_ORIGINS: z.string().default(''),
    RATE_LIMIT_TTL_SECONDS: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_PER_USER: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_PER_IP: z.coerce.number().int().positive().default(300),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (!env.JWT_PUBLIC_KEY && !env.JWT_PUBLIC_KEY_FILE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_FILE',
        path: ['JWT_PUBLIC_KEY'],
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** @nestjs/config `validate` hook. Throws (engine won't boot) on bad config. */
export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
