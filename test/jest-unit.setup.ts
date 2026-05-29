/**
 * Unit-test env shim. Some service modules transitively import config.module.ts
 * which runs ConfigModule.forRoot() (and validateEnv) at import time. Unit
 * tests mock their dependencies and never touch a real DB / Redis / PayFast,
 * so we provide dummy values here purely to satisfy boot-time env validation.
 * (E2E tests set real testcontainer URLs in their own beforeAll and do not
 * rely on this file.)
 */
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_PUBLIC_KEY ??= 'unit-test-public-key';
process.env.PAYOUT_METHOD_ENCRYPTION_KEY ??= 'unit-test-payout-encryption-key-32bytes';
process.env.PUBSUB_ENABLED ??= 'false';
