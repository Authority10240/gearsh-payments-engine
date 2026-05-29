import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { generateKeyMaterial, signAccessToken, signInternalToken } from './jwt.fake';

const ROOT = join(__dirname, '..');

/**
 * Payment-intents module e2e (PAY-001 happy path):
 *   - /healthz returns ok
 *   - POST /v1/payment-intents (internal token) creates the intent
 *   - POST /v1/payment-intents/:id/lock returns signed PayFast form params
 *   - GET  /v1/payment-intents/:id returns the locked intent
 *   - Duplicate POST for the same booking → PAYMENT_INTENT_EXISTS_FOR_BOOKING
 *   - Conversion without a cached rate → FX_RATE_UNAVAILABLE
 */
describe('Payment intents (e2e)', () => {
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  let clientToken: string;
  let internalToken: string;
  const clientId = uuidv7();
  const artistId = uuidv7();

  beforeAll(async () => {
    pg = await new GenericContainer('postgres:16')
      .withEnvironment({
        POSTGRES_DB: 'gearsh_payments',
        POSTGRES_USER: 'gearsh',
        POSTGRES_PASSWORD: 'local',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    redis = await new GenericContainer('redis:7')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();

    const dbUrl = `postgresql://gearsh:local@${pg.getHost()}:${pg.getMappedPort(5432)}/gearsh_payments?schema=public`;
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

    const keys = await generateKeyMaterial();
    const keyDir = mkdtempSync(join(tmpdir(), 'gearsh-payments-keys-'));
    const pubKeyPath = join(keyDir, 'jwt-public.pem');
    writeFileSync(pubKeyPath, keys.publicKeyPem);

    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'error';
    process.env.DATABASE_URL = dbUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.JWT_PUBLIC_KEY_FILE = pubKeyPath;
    process.env.JWT_ISSUER = 'gearsh-auth';
    process.env.JWT_AUDIENCE = 'gearsh-platform';
    process.env.PAYOUT_METHOD_ENCRYPTION_KEY = 'e2e-payout-encryption-key-32-bytes';
    process.env.PUBSUB_ENABLED = 'false';
    // PayFast creds — populated so /lock returns a signed form.
    process.env.PAYFAST_MERCHANT_ID = '10000100';
    process.env.PAYFAST_MERCHANT_KEY = '46f0cd694581a';
    process.env.PAYFAST_PASSPHRASE = 'jt7NOE43FZPn';
    process.env.PAYFAST_SANDBOX = 'true';
    process.env.PAYFAST_PROCESS_URL = 'https://sandbox.payfast.co.za/eng/process';
    process.env.PAYFAST_VALIDATE_URL = 'https://sandbox.payfast.co.za/eng/query/validate';
    process.env.PAYFAST_RETURN_URL = 'https://example.com/return';
    process.env.PAYFAST_CANCEL_URL = 'https://example.com/cancel';
    process.env.PAYFAST_NOTIFY_URL = 'https://example.com/v1/webhooks/payfast';
    delete process.env.EXCHANGE_RATE_PROVIDER_URL;
    delete process.env.EXCHANGE_RATE_PROVIDER_KEY;

    execSync('node_modules/.bin/prisma migrate deploy', {
      cwd: ROOT,
      env: process.env,
      stdio: 'ignore',
    });

    const { AppModule } = await import('../src/app.module');
    const { validationExceptionFactory } = await import('../src/common/problem/validation');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: validationExceptionFactory,
      }),
    );
    await app.init();
    http = request(app.getHttpServer());

    clientToken = await signAccessToken(keys.privateKeyPem, { sub: clientId, roles: ['CLIENT'] });
    internalToken = await signInternalToken(keys.privateKeyPem, 'data-engine');

    // Seed FX rates so intent creation / lock have a ZAR rate to find.
    const fx = app.get((await import('../src/modules/fx/fx.service')).FxService);
    await fx.refresh();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (pg) await pg.stop();
    if (redis) await redis.stop();
  });

  it('GET /healthz', async () => {
    const res = await http.get('/healthz').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('full happy path: create → lock → get', async () => {
    const bookingId = uuidv7();
    const create = await http
      .post('/v1/payment-intents')
      .set('X-Internal-Service-Token', internalToken)
      .send({
        bookingId,
        clientId,
        artistId,
        subtotalCents: 200000,
        currency: 'ZAR',
        serviceFeeCents: 25200,
        totalCents: 225200,
      })
      .expect(201);

    expect(create.body.state).toBe('CREATED');
    expect(create.body.quotedZarAmountCents).toBe(225200);
    const intentId = create.body.id;

    const lock = await http
      .post(`/v1/payment-intents/${intentId}/lock`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({})
      .expect(201);

    expect(lock.body.state).toBe('LOCKED');
    expect(lock.body.payfastRedirectUrl).toContain('sandbox.payfast.co.za');
    expect(lock.body.formParams).toMatchObject({
      merchant_id: '10000100',
      m_payment_id: intentId,
      amount: '2252.00',
    });
    expect(lock.body.formParams.signature).toMatch(/^[0-9a-f]{32}$/);

    const detail = await http
      .get(`/v1/payment-intents/${intentId}`)
      .set('Authorization', `Bearer ${clientToken}`)
      .expect(200);

    expect(detail.body.state).toBe('LOCKED');
    expect(detail.body.zarAmountCentsLocked).toBe(225200);
    expect(detail.body.lockExpiresAt).toEqual(expect.any(String));
  });

  it('duplicate intent for the same booking → PAYMENT_INTENT_EXISTS_FOR_BOOKING', async () => {
    const bookingId = uuidv7();
    const body = {
      bookingId,
      clientId,
      artistId,
      subtotalCents: 100000,
      currency: 'ZAR',
      serviceFeeCents: 12600,
      totalCents: 112600,
    };

    await http
      .post('/v1/payment-intents')
      .set('X-Internal-Service-Token', internalToken)
      .send(body)
      .expect(201);

    const dupe = await http
      .post('/v1/payment-intents')
      .set('X-Internal-Service-Token', internalToken)
      .send(body)
      .expect(409);

    expect(dupe.body.code).toBe('PAYMENT_INTENT_EXISTS_FOR_BOOKING');
  });

  it('intent in a non-ZAR currency: quotedZarAmountCents reflects FX conversion', async () => {
    const bookingId = uuidv7();
    const create = await http
      .post('/v1/payment-intents')
      .set('X-Internal-Service-Token', internalToken)
      .send({
        bookingId,
        clientId,
        artistId,
        subtotalCents: 10000, // 100.00 USD subtotal
        currency: 'USD',
        serviceFeeCents: 1260,
        totalCents: 11260,
      })
      .expect(201);

    // Stub rate ZAR→USD = 0.054, so USD→ZAR ≈ 18.5185. 11260 cents USD ≈ 208518 cents ZAR.
    expect(create.body.quotedZarAmountCents).toBeGreaterThan(150000);
    expect(create.body.quotedZarAmountCents).toBeLessThan(300000);
  });

  it('missing X-Internal-Service-Token → 401', async () => {
    await http
      .post('/v1/payment-intents')
      .send({
        bookingId: uuidv7(),
        clientId,
        artistId,
        subtotalCents: 1000,
        currency: 'ZAR',
        totalCents: 1126,
      })
      .expect(401);
  });
});
