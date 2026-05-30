import { readFileSync } from 'node:fs';
import { envSchema, type Env } from './env.validation';

/**
 * Structured, typed configuration assembled from the validated env.
 * Inject via the APP_CONFIG token.
 */
export interface AppConfig {
  env: Env['NODE_ENV'];
  port: number;
  logLevel: string;
  serviceName: string;
  database: { url: string };
  redis: { url: string };
  jwt: {
    publicKey: string;
    issuer: string;
    audience: string;
    internalAudience: string;
    /** TTL for the local sid denylist (PAY-REPAIR-001). */
    accessTtlSeconds: number;
  };
  services: {
    authUrl?: string;
    dataUrl?: string;
    internalServiceToken?: string;
  };
  business: {
    serviceFeePercent: number;
    disputeWindowDays: number;
    fxIntentLockTtlMinutes: number;
  };
  payfast: {
    merchantId?: string;
    merchantKey?: string;
    passphrase?: string;
    sandbox: boolean;
    processUrl?: string;
    validateUrl?: string;
    returnUrl?: string;
    cancelUrl?: string;
    notifyUrl?: string;
    refundUrl?: string;
    adhocPaymentUrl?: string;
    /** Parsed CIDR/IP entries from PAYFAST_IP_WHITELIST. */
    ipWhitelist: string[];
    /** True when ALL hard-required PayFast creds are present. */
    enabled: boolean;
  };
  fx: {
    provider: 'open_exchange_rates' | 'stub';
    providerUrl?: string;
    providerKey?: string;
    /** True when provider creds are populated (else falls back to stub). */
    liveProviderEnabled: boolean;
  };
  payoutMethodEncryptionKey: string;
  payouts: {
    dispatchEnabled: boolean;
    retryEnabled: boolean;
    maxAttempts: number;
    dispatchBatchSize: number;
  };
  reconciliation: {
    enabled: boolean;
    alertThresholdCents: number;
    alertEmail?: string;
    stuckHoldHours: number;
    stuckPayoutHours: number;
    stuckDisputeDays: number;
  };
  /**
   * Subscriber-driven actor id (PAY-006). RefundsService.issueRefund requires
   * a non-null initiatedBy uuid; subscribers pass this when they originate
   * the refund from a bookings.cancelled / disputes.resolved event.
   */
  systemUserId: string;
  pubsub: {
    projectId?: string;
    publishTopics: string[];
    subscriptions: string[];
    emulatorHost?: string;
    enabled: boolean;
  };
  cors: { allowedOrigins: string[] };
  rateLimit: { ttlSeconds: number; perUser: number; perIp: number };
  otel: { endpoint?: string };
}

function resolveKey(inline?: string, file?: string): string {
  if (inline && inline.trim().length > 0) {
    // Secret Manager / .env often store PEMs with literal \n — normalise.
    return inline.includes('\\n') ? inline.replace(/\\n/g, '\n') : inline;
  }
  if (file) return readFileSync(file, 'utf8');
  throw new Error('Missing key material (neither inline value nor file provided)');
}

function csv(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export function buildConfig(env: Env): AppConfig {
  const payfastEnabled = Boolean(
    env.PAYFAST_MERCHANT_ID &&
    env.PAYFAST_MERCHANT_KEY &&
    env.PAYFAST_PASSPHRASE &&
    env.PAYFAST_PROCESS_URL,
  );
  const fxLiveEnabled = Boolean(
    env.EXCHANGE_RATE_PROVIDER === 'open_exchange_rates' &&
    env.EXCHANGE_RATE_PROVIDER_URL &&
    env.EXCHANGE_RATE_PROVIDER_KEY,
  );

  return {
    env: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    serviceName: env.SERVICE_NAME,
    database: { url: env.DATABASE_URL },
    redis: { url: env.REDIS_URL },
    jwt: {
      publicKey: resolveKey(env.JWT_PUBLIC_KEY, env.JWT_PUBLIC_KEY_FILE),
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      internalAudience: env.INTERNAL_JWT_AUDIENCE,
      accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    },
    services: {
      authUrl: env.AUTH_SERVICE_URL,
      dataUrl: env.DATA_SERVICE_URL,
      internalServiceToken: env.INTERNAL_SERVICE_TOKEN,
    },
    business: {
      serviceFeePercent: env.SERVICE_FEE_PERCENT,
      disputeWindowDays: env.DISPUTE_WINDOW_DAYS,
      fxIntentLockTtlMinutes: env.FX_INTENT_LOCK_TTL_MINUTES,
    },
    payfast: {
      merchantId: env.PAYFAST_MERCHANT_ID,
      merchantKey: env.PAYFAST_MERCHANT_KEY,
      passphrase: env.PAYFAST_PASSPHRASE,
      sandbox: env.PAYFAST_SANDBOX ?? true,
      processUrl: env.PAYFAST_PROCESS_URL,
      validateUrl: env.PAYFAST_VALIDATE_URL,
      returnUrl: env.PAYFAST_RETURN_URL,
      cancelUrl: env.PAYFAST_CANCEL_URL,
      notifyUrl: env.PAYFAST_NOTIFY_URL,
      refundUrl: env.PAYFAST_REFUND_URL,
      adhocPaymentUrl: env.PAYFAST_ADHOC_PAYMENT_URL,
      ipWhitelist: csv(env.PAYFAST_IP_WHITELIST),
      enabled: payfastEnabled,
    },
    fx: {
      provider: env.EXCHANGE_RATE_PROVIDER,
      providerUrl: env.EXCHANGE_RATE_PROVIDER_URL,
      providerKey: env.EXCHANGE_RATE_PROVIDER_KEY,
      liveProviderEnabled: fxLiveEnabled,
    },
    payoutMethodEncryptionKey: env.PAYOUT_METHOD_ENCRYPTION_KEY,
    payouts: {
      dispatchEnabled: env.PAYOUT_DISPATCH_ENABLED ?? true,
      retryEnabled: env.PAYOUT_RETRY_ENABLED ?? true,
      maxAttempts: env.PAYOUT_MAX_ATTEMPTS,
      dispatchBatchSize: env.PAYOUT_DISPATCH_BATCH_SIZE,
    },
    reconciliation: {
      enabled: env.RECONCILIATION_ENABLED ?? true,
      alertThresholdCents: env.RECONCILIATION_ALERT_THRESHOLD_CENTS,
      alertEmail: env.RECONCILIATION_ALERT_EMAIL,
      stuckHoldHours: env.STUCK_HOLD_HOURS,
      stuckPayoutHours: env.STUCK_PAYOUT_HOURS,
      stuckDisputeDays: env.STUCK_DISPUTE_DAYS,
    },
    systemUserId: env.SYSTEM_USER_ID,
    pubsub: {
      projectId: env.PUBSUB_PROJECT_ID,
      publishTopics: csv(env.PUBSUB_PUBLISH_TOPICS),
      subscriptions: csv(env.PUBSUB_SUBSCRIPTIONS),
      emulatorHost: env.PUBSUB_EMULATOR_HOST,
      enabled: env.PUBSUB_ENABLED ?? Boolean(env.PUBSUB_PROJECT_ID || env.PUBSUB_EMULATOR_HOST),
    },
    cors: { allowedOrigins: csv(env.CORS_ALLOWED_ORIGINS) },
    rateLimit: {
      ttlSeconds: env.RATE_LIMIT_TTL_SECONDS,
      perUser: env.RATE_LIMIT_PER_USER,
      perIp: env.RATE_LIMIT_PER_IP,
    },
    otel: { endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT },
  };
}

/**
 * @nestjs/config `load` factory. Re-parses process.env through the schema so
 * coercion + defaults are applied (validateEnv already ran at boot, so this
 * never throws), then assembles the structured AppConfig.
 */
export default (): { app: AppConfig } => ({ app: buildConfig(envSchema.parse(process.env)) });
