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
 * PAY-002 PayFast ITN end-to-end. Mirrors payment-intents.e2e-spec.ts boot
 * pattern (testcontainer Postgres + Redis + the full Nest app).
 *
 * Scenarios:
 *   - Happy path COMPLETE → 200; transactions SUCCEEDED, intent SUCCEEDED,
 *     escrow_holds HELD, escrow_events HELD, 3 ledger entries Σ-balanced, 2
 *     outbox rows.
 *   - Duplicate ITN with same payment_status → 200, no extra rows.
 *   - Bad signature → 400 PAYFAST_SIGNATURE_INVALID.
 *   - Non-whitelisted IP → 403 PAYFAST_IP_NOT_WHITELISTED.
 *   - Amount mismatch → 400 PAYFAST_VALIDATION_FAILED.
 *   - FAILED status → 200, intent FAILED, no hold, payments.failed in outbox.
 *
 * Skips when Docker isn't available locally. Specs compile via
 * `pnpm jest --listTests --config test/jest-e2e.json`.
 */
describe('PayFast ITN webhook (e2e)', () => {
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  // Lazily imported after the module compiles to dodge env-side-effects.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payfast: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let signParams: any;

  let clientToken: string;
  let internalToken: string;
  const clientId = uuidv7();
  const artistId = uuidv7();
  // 127.0.0.1 is what supertest uses as the source — it must be inside the
  // whitelist for the webhook to accept the call.
  const WHITELIST = '127.0.0.0/8,196.33.227.224/27,144.126.193.139';
  const PAYFAST_MERCHANT_ID = '10000100';
  const PAYFAST_MERCHANT_KEY = '46f0cd694581a';
  const PAYFAST_PASSPHRASE = 'jt7NOE43FZPn';

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
    process.env.PAYFAST_MERCHANT_ID = PAYFAST_MERCHANT_ID;
    process.env.PAYFAST_MERCHANT_KEY = PAYFAST_MERCHANT_KEY;
    process.env.PAYFAST_PASSPHRASE = PAYFAST_PASSPHRASE;
    process.env.PAYFAST_SANDBOX = 'true';
    process.env.PAYFAST_PROCESS_URL = 'https://sandbox.payfast.co.za/eng/process';
    process.env.PAYFAST_VALIDATE_URL = 'https://sandbox.payfast.co.za/eng/query/validate';
    process.env.PAYFAST_RETURN_URL = 'https://example.com/return';
    process.env.PAYFAST_CANCEL_URL = 'https://example.com/cancel';
    process.env.PAYFAST_NOTIFY_URL = 'https://example.com/v1/webhooks/payfast';
    process.env.PAYFAST_IP_WHITELIST = WHITELIST;
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
    // Match production main.ts: trust the first proxy so req.ip is the client.
    (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set(
      'trust proxy',
      1,
    );
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

    prisma = app.get((await import('../src/infra/prisma/prisma.service')).PrismaService);
    payfast = app.get((await import('../src/infra/payfast/payfast.client')).PayFastClient);
    signParams = (await import('../src/infra/payfast/signature.util')).signParams;

    // Stub the s2s validate call so we don't hit PayFast from CI.
    jest.spyOn(payfast, 'validateItn').mockResolvedValue(true);

    const fx = app.get((await import('../src/modules/fx/fx.service')).FxService);
    await fx.refresh();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (pg) await pg.stop();
    if (redis) await redis.stop();
  });

  // ── helpers ─────────────────────────────────────────────────────────
  async function createLockedIntent(opts: {
    subtotalCents: number;
    serviceFeeCents: number;
  }): Promise<{
    intentId: string;
    mPaymentId: string;
    amountMajor: string;
    zarAmountCentsLocked: number;
  }> {
    const bookingId = uuidv7();
    const create = await http
      .post('/v1/payment-intents')
      .set('X-Internal-Service-Token', internalToken)
      .send({
        bookingId,
        clientId,
        artistId,
        subtotalCents: opts.subtotalCents,
        currency: 'ZAR',
        serviceFeeCents: opts.serviceFeeCents,
        totalCents: opts.subtotalCents + opts.serviceFeeCents,
      })
      .expect(201);

    const intentId = create.body.id;
    const lock = await http
      .post(`/v1/payment-intents/${intentId}/lock`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({})
      .expect(201);

    return {
      intentId,
      mPaymentId: lock.body.mPaymentId,
      amountMajor: lock.body.formParams.amount as string,
      zarAmountCentsLocked: lock.body.zarAmountCentsLocked ?? create.body.totalCents,
    };
  }

  function buildItnForm(args: {
    pfPaymentId: string;
    mPaymentId: string;
    amountGross: string;
    paymentStatus: 'COMPLETE' | 'FAILED';
    merchantId?: string;
    passphrase?: string | null;
    overrideSignature?: string;
  }): URLSearchParams {
    const params: Record<string, string> = {
      m_payment_id: args.mPaymentId,
      pf_payment_id: args.pfPaymentId,
      payment_status: args.paymentStatus,
      item_name: 'Gearsh booking',
      amount_gross: args.amountGross,
      amount_fee: '-0.00',
      amount_net: args.amountGross,
      merchant_id: args.merchantId ?? PAYFAST_MERCHANT_ID,
    };
    const signature =
      args.overrideSignature ??
      signParams(
        params,
        args.passphrase === undefined ? PAYFAST_PASSPHRASE : (args.passphrase ?? undefined),
      );
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) form.append(k, v);
    form.append('signature', signature);
    return form;
  }

  // ── tests ──────────────────────────────────────────────────────────
  it('happy path COMPLETE → 200, transaction + hold + ledger + 2 outbox rows', async () => {
    const { intentId, mPaymentId, amountMajor, zarAmountCentsLocked } = await createLockedIntent({
      subtotalCents: 200000,
      serviceFeeCents: 25200,
    });
    const pfPaymentId = `pf_${uuidv7()}`;
    const form = buildItnForm({
      pfPaymentId,
      mPaymentId,
      amountGross: amountMajor,
      paymentStatus: 'COMPLETE',
    });

    const res = await http
      .post('/v1/webhooks/payfast')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(form.toString())
      .expect(200);
    expect(res.body).toEqual({ status: 'ok' });

    const intent = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
    expect(intent.state).toBe('SUCCEEDED');
    expect(intent.pfPaymentId).toBe(pfPaymentId);

    const txns = await prisma.transaction.findMany({ where: { paymentIntentId: intentId } });
    expect(txns).toHaveLength(1);
    expect(txns[0].state).toBe('SUCCEEDED');
    expect(txns[0].gatewayTxnId).toBe(pfPaymentId);
    expect(Number(txns[0].amountCents)).toBe(zarAmountCentsLocked);

    const holds = await prisma.escrowHold.findMany({ where: { paymentIntentId: intentId } });
    expect(holds).toHaveLength(1);
    expect(holds[0].state).toBe('HELD');
    expect(Number(holds[0].amountCents) + Number(holds[0].platformFeeCents)).toBe(
      zarAmountCentsLocked,
    );

    const events = await prisma.escrowEvent.findMany({ where: { holdId: holds[0].id } });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('HELD');

    const ledger = await prisma.ledgerEntry.findMany({ where: { holdId: holds[0].id } });
    expect(ledger).toHaveLength(3);
    const debits = ledger
      .filter((e: { direction: string }) => e.direction === 'DEBIT')
      .reduce((s: bigint, e: { amountCents: bigint }) => s + BigInt(e.amountCents), 0n);
    const credits = ledger
      .filter((e: { direction: string }) => e.direction === 'CREDIT')
      .reduce((s: bigint, e: { amountCents: bigint }) => s + BigInt(e.amountCents), 0n);
    expect(debits).toBe(credits);

    const outbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: { in: [intentId, holds[0].id] } },
    });
    const types = outbox.map((r: { eventType: string }) => r.eventType).sort();
    expect(types).toEqual(['escrow.held', 'payments.succeeded']);
  });

  it('duplicate ITN with same payment_status → 200, no duplicate rows or outbox writes', async () => {
    const { intentId, mPaymentId, amountMajor } = await createLockedIntent({
      subtotalCents: 100000,
      serviceFeeCents: 12600,
    });
    const pfPaymentId = `pf_${uuidv7()}`;
    const form = buildItnForm({
      pfPaymentId,
      mPaymentId,
      amountGross: amountMajor,
      paymentStatus: 'COMPLETE',
    });

    await http
      .post('/v1/webhooks/payfast')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(form.toString())
      .expect(200);

    // Replay the same payload.
    await http
      .post('/v1/webhooks/payfast')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(form.toString())
      .expect(200);

    const txns = await prisma.transaction.findMany({ where: { paymentIntentId: intentId } });
    expect(txns).toHaveLength(1);
    const holds = await prisma.escrowHold.findMany({ where: { paymentIntentId: intentId } });
    expect(holds).toHaveLength(1);
    const outbox = await prisma.outboxEvent.findMany({
      where: {
        OR: [
          { aggregateId: intentId, eventType: 'payments.succeeded' },
          { aggregateId: holds[0].id, eventType: 'escrow.held' },
        ],
      },
    });
    expect(outbox).toHaveLength(2);
  });

  it('bad signature → 400 PAYFAST_SIGNATURE_INVALID, no rows', async () => {
    const { intentId, mPaymentId, amountMajor } = await createLockedIntent({
      subtotalCents: 50000,
      serviceFeeCents: 6300,
    });
    const pfPaymentId = `pf_${uuidv7()}`;
    const form = buildItnForm({
      pfPaymentId,
      mPaymentId,
      amountGross: amountMajor,
      paymentStatus: 'COMPLETE',
      overrideSignature: '0'.repeat(32),
    });

    const res = await http
      .post('/v1/webhooks/payfast')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(form.toString())
      .expect(400);
    expect(res.body.code).toBe('PAYFAST_SIGNATURE_INVALID');

    const txns = await prisma.transaction.findMany({ where: { paymentIntentId: intentId } });
    expect(txns).toHaveLength(0);
  });

  it('non-whitelisted source IP → 403 PAYFAST_IP_NOT_WHITELISTED', async () => {
    const { mPaymentId, amountMajor } = await createLockedIntent({
      subtotalCents: 50000,
      serviceFeeCents: 6300,
    });
    const pfPaymentId = `pf_${uuidv7()}`;
    const form = buildItnForm({
      pfPaymentId,
      mPaymentId,
      amountGross: amountMajor,
      paymentStatus: 'COMPLETE',
    });

    // Simulate Cloud Run forwarding via X-Forwarded-For = a non-whitelisted IP.
    const res = await http
      .post('/v1/webhooks/payfast')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('X-Forwarded-For', '10.20.30.40')
      .send(form.toString())
      .expect(403);
    expect(res.body.code).toBe('PAYFAST_IP_NOT_WHITELISTED');
  });

  it('amount_gross mismatch → 400 PAYFAST_VALIDATION_FAILED', async () => {
    const { intentId, mPaymentId } = await createLockedIntent({
      subtotalCents: 200000,
      serviceFeeCents: 25200,
    });
    const pfPaymentId = `pf_${uuidv7()}`;
    const form = buildItnForm({
      pfPaymentId,
      mPaymentId,
      amountGross: '1.00', // intentional mismatch
      paymentStatus: 'COMPLETE',
    });

    const res = await http
      .post('/v1/webhooks/payfast')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(form.toString())
      .expect(400);
    expect(res.body.code).toBe('PAYFAST_VALIDATION_FAILED');

    const txns = await prisma.transaction.findMany({ where: { paymentIntentId: intentId } });
    expect(txns).toHaveLength(0);
  });

  it('FAILED status → 200, intent FAILED, payments.failed outbox row, no hold', async () => {
    const { intentId, mPaymentId, amountMajor } = await createLockedIntent({
      subtotalCents: 50000,
      serviceFeeCents: 6300,
    });
    const pfPaymentId = `pf_${uuidv7()}`;
    const form = buildItnForm({
      pfPaymentId,
      mPaymentId,
      amountGross: amountMajor,
      paymentStatus: 'FAILED',
    });

    await http
      .post('/v1/webhooks/payfast')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(form.toString())
      .expect(200);

    const intent = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
    expect(intent.state).toBe('FAILED');

    const txns = await prisma.transaction.findMany({ where: { paymentIntentId: intentId } });
    expect(txns).toHaveLength(1);
    expect(txns[0].state).toBe('FAILED');

    const holds = await prisma.escrowHold.findMany({ where: { paymentIntentId: intentId } });
    expect(holds).toHaveLength(0);

    const outbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: intentId, eventType: 'payments.failed' },
    });
    expect(outbox).toHaveLength(1);
  });
});
