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
import { generateKeyMaterial, signAccessToken } from './jwt.fake';

const ROOT = join(__dirname, '..');

/**
 * PAY-005 payouts e2e — covers the dispatcher + retry crons, the artist /
 * admin payout-method routes, and the PayFast Adhoc round-trip.
 *
 * Strategy: seed payouts + artist_payout_methods directly via Prisma (mirrors
 * escrow.e2e + refunds.e2e). PayFastClient.adhocPayment is overridden with a
 * jest mock — the live HTTP call is exercised by the unit spec; here we want
 * to assert the dispatcher orchestration end-to-end against real Postgres
 * (pgcrypto extension is on, so encrypt/decrypt round-trips work).
 *
 * Scenarios:
 *   1. PUT /v1/payouts/method (artist) → row inserted, isVerified=false.
 *      POST /v1/admin/payouts/methods/:id/verify → isVerified=true.
 *      Decrypt round-trip equals the digits the artist sent.
 *   2. Dispatcher happy path: QUEUED payout + verified method →
 *      PayFast Adhoc mock succeeds → payout SUCCEEDED, gatewayPayoutId set,
 *      last_used_at on method bumped, escrow.payout.succeeded outbox row.
 *   3. Dispatcher with NO verified method → payout FAILED with reason
 *      NO_PAYOUT_METHOD / PAYOUT_METHOD_NOT_VERIFIED, escrow.payout.failed
 *      outbox row, hold still in its prior (RELEASED) state.
 *   4. Race guard: PROCESSING refund on the same hold → dispatcher SKIPS
 *      the payout (still QUEUED, no PayFast call).
 *   5. PayFast 5xx three times → payout FAILED after 3 retries,
 *      escrow.payout.failed outbox row.
 *   6. Retry job: payout FAILED 2h ago with attempts=0 → requeued (state=QUEUED).
 */
describe('Payouts dispatcher + artist payout methods (e2e)', () => {
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  const payfastAdhocMock = jest.fn();

  let adminToken: string;
  let artistToken: string;
  const adminId = uuidv7();
  const artistId = uuidv7();
  const clientId = uuidv7();

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
    process.env.DISPUTE_WINDOW_DAYS = '7';
    // Disable the cron itself — we call runOnce() directly in tests so we
    // control timing and don't race the scheduler.
    process.env.PAYOUT_DISPATCH_ENABLED = 'false';
    process.env.PAYOUT_RETRY_ENABLED = 'false';
    process.env.PAYOUT_MAX_ATTEMPTS = '5';
    process.env.PAYFAST_MERCHANT_ID = '10000100';
    process.env.PAYFAST_MERCHANT_KEY = '46f0cd694581a';
    process.env.PAYFAST_PASSPHRASE = 'jt7NOE43FZPn';
    process.env.PAYFAST_PROCESS_URL = 'https://sandbox.payfast.co.za/eng/process';
    process.env.PAYFAST_ADHOC_PAYMENT_URL = 'https://api.payfast.co.za/transactions/adhoc';
    delete process.env.EXCHANGE_RATE_PROVIDER_URL;
    delete process.env.EXCHANGE_RATE_PROVIDER_KEY;

    execSync('node_modules/.bin/prisma migrate deploy', {
      cwd: ROOT,
      env: process.env,
      stdio: 'ignore',
    });

    const { AppModule } = await import('../src/app.module');
    const { validationExceptionFactory } = await import('../src/common/problem/validation');
    const { PayFastClient } = await import('../src/infra/payfast/payfast.client');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PayFastClient)
      .useValue({
        adhocPayment: payfastAdhocMock,
        enabled: true,
        buildCheckoutForm: jest.fn(),
        verifyItnSignature: jest.fn(),
        validateItn: jest.fn(),
        refund: jest.fn(),
      })
      .compile();
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

    adminToken = await signAccessToken(keys.privateKeyPem, { sub: adminId, roles: ['ADMIN'] });
    artistToken = await signAccessToken(keys.privateKeyPem, { sub: artistId, roles: ['ARTIST'] });

    prisma = app.get((await import('../src/infra/prisma/prisma.service')).PrismaService);
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pg) await pg.stop();
    if (redis) await redis.stop();
  });

  beforeEach(() => {
    payfastAdhocMock.mockReset();
  });

  // ── helpers ────────────────────────────────────────────────────────────

  /** Seed a HELD hold that has been released so a payout can be queued. */
  async function seedReleasedHoldWithPayout(opts: {
    artistId: string;
    amountCents: number;
    dispatchAfter: Date;
  }): Promise<{ holdId: string; payoutId: string; intentId: string }> {
    const bookingId = uuidv7();
    const intent = await prisma.paymentIntent.create({
      data: {
        bookingId,
        userId: clientId,
        artistId: opts.artistId,
        subtotalCents: BigInt(opts.amountCents),
        serviceFeeCents: 0n,
        totalCents: BigInt(opts.amountCents),
        currency: 'ZAR',
        clientCurrency: 'ZAR',
        state: 'SUCCEEDED',
      },
    });
    const hold = await prisma.escrowHold.create({
      data: {
        bookingId,
        paymentIntentId: intent.id,
        clientId,
        artistId: opts.artistId,
        amountCents: BigInt(opts.amountCents),
        platformFeeCents: 0n,
        currency: 'ZAR',
        state: 'RELEASED',
      },
    });
    const payout = await prisma.payout.create({
      data: {
        artistId: opts.artistId,
        holdId: hold.id,
        amountCents: BigInt(opts.amountCents),
        currency: 'ZAR',
        state: 'QUEUED',
        dispatchAfter: opts.dispatchAfter,
      },
    });
    return { holdId: hold.id, payoutId: payout.id, intentId: intent.id };
  }

  async function getDispatcher(): Promise<{ runOnce(): Promise<unknown> }> {
    const mod = await import('../src/modules/payouts/jobs/payout-dispatcher.job');
    return app.get(mod.PayoutDispatcherJob);
  }

  async function getRetryJob(): Promise<{ runOnce(): Promise<unknown> }> {
    const mod = await import('../src/modules/payouts/jobs/payout-retry.job');
    return app.get(mod.PayoutRetryJob);
  }

  // ── tests ──────────────────────────────────────────────────────────────

  it('artist upsert + admin verify + plaintext round-trip', async () => {
    const upsertRes = await http
      .put('/v1/payouts/method')
      .set('Authorization', `Bearer ${artistToken}`)
      .send({
        bankName: 'Standard Bank',
        accountHolderName: 'Test Artist',
        accountNumber: '1234567890',
        branchCode: '051001',
        accountType: 'CHEQUE',
      })
      .expect(200);

    expect(upsertRes.body.isVerified).toBe(false);
    expect(upsertRes.body.accountNumberMasked).toBe('••••••7890');
    expect(upsertRes.body.bankName).toBe('Standard Bank');

    // Admin verify.
    const verifyRes = await http
      .post(`/v1/admin/payouts/methods/${artistId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(verifyRes.body.isVerified).toBe(true);
    expect(verifyRes.body.verifiedBy).toBe(adminId);

    // Admin ?unmask=true round-trip → plaintext digits.
    const unmaskRes = await http
      .get(`/v1/admin/payouts/methods/${artistId}?unmask=true`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(unmaskRes.body.accountNumber).toBe('1234567890');
  });

  it('upsert overwrites and resets isVerified', async () => {
    // Artist already has a verified method from the previous test — second
    // PUT must reset isVerified=false.
    const res = await http
      .put('/v1/payouts/method')
      .set('Authorization', `Bearer ${artistToken}`)
      .send({
        bankName: 'Nedbank',
        accountHolderName: 'Test Artist (Updated)',
        accountNumber: '9876543210',
        branchCode: '198765',
        accountType: 'SAVINGS',
      })
      .expect(200);
    expect(res.body.isVerified).toBe(false);
    expect(res.body.bankName).toBe('Nedbank');
    expect(res.body.accountNumberMasked).toBe('••••••3210');
  });

  it('dispatcher happy path: QUEUED + verified method → SUCCEEDED, escrow.payout.succeeded outbox', async () => {
    const happyArtistId = uuidv7();
    // Seed verified method directly so we don't fight the previous test's row.
    const { PrismaService } = await import('../src/infra/prisma/prisma.service');
    const { EncryptionService } = await import('../src/common/crypto/encryption.service');
    const encryption = app.get(EncryptionService);
    const encrypted = await encryption.encrypt('5555555555');
    const method = await app.get(PrismaService).artistPayoutMethod.create({
      data: {
        artistUserId: happyArtistId,
        bankName: 'Test Bank',
        accountHolderName: 'Happy Artist',
        accountNumberEncrypted: encrypted,
        branchCode: '123456',
        accountType: 'CHEQUE',
        isVerified: true,
        verifiedAt: new Date(),
        verifiedBy: adminId,
      },
    });

    const { payoutId, holdId } = await seedReleasedHoldWithPayout({
      artistId: happyArtistId,
      amountCents: 50_000,
      dispatchAfter: new Date(Date.now() - 60 * 60 * 1000),
    });

    payfastAdhocMock.mockResolvedValue({
      ok: true,
      payoutId: 'pf-payout-OK',
      rawResponse: { payout_id: 'pf-payout-OK' },
    });

    const dispatcher = await getDispatcher();
    await dispatcher.runOnce();

    const payout = await prisma.payout.findUnique({ where: { id: payoutId } });
    expect(payout.state).toBe('SUCCEEDED');
    expect(payout.gatewayPayoutId).toBe('pf-payout-OK');
    expect(payout.completedAt).toBeTruthy();
    expect(payout.attemptedAt).toBeTruthy();

    // lastUsedAt on the method got bumped.
    const refreshedMethod = await prisma.artistPayoutMethod.findUnique({
      where: { id: method.id },
    });
    expect(refreshedMethod.lastUsedAt).toBeTruthy();

    // escrow.payout.succeeded outbox row.
    const outbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: payoutId, eventType: 'escrow.payout.succeeded' },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload.data.gatewayPayoutId).toBe('pf-payout-OK');
    expect(outbox[0].payload.data.holdId).toBe(holdId);

    // PayFast call: amount in major units string, account number = decrypted plaintext.
    expect(payfastAdhocMock).toHaveBeenCalledTimes(1);
    const call = payfastAdhocMock.mock.calls[0][0];
    expect(call.accountNumber).toBe('5555555555');
    expect(call.amountCents).toBe(50_000n);
  });

  it('dispatcher: NO_PAYOUT_METHOD when artist has no method', async () => {
    const orphanArtistId = uuidv7();
    const { payoutId, holdId } = await seedReleasedHoldWithPayout({
      artistId: orphanArtistId,
      amountCents: 25_000,
      dispatchAfter: new Date(Date.now() - 60 * 60 * 1000),
    });

    const dispatcher = await getDispatcher();
    await dispatcher.runOnce();

    const payout = await prisma.payout.findUnique({ where: { id: payoutId } });
    expect(payout.state).toBe('FAILED');
    expect(payout.failureReason).toBe('NO_PAYOUT_METHOD');
    expect(payout.failedAt).toBeTruthy();

    // hold unchanged (still RELEASED from seed).
    const hold = await prisma.escrowHold.findUnique({ where: { id: holdId } });
    expect(hold.state).toBe('RELEASED');

    // escrow.payout.failed outbox row.
    const outbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: payoutId, eventType: 'escrow.payout.failed' },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload.data.failureReason).toBe('NO_PAYOUT_METHOD');

    // PayFast was NOT called.
    expect(payfastAdhocMock).not.toHaveBeenCalled();
  });

  it('dispatcher: PAYOUT_METHOD_NOT_VERIFIED when method exists but is_verified=false', async () => {
    const unverifiedArtistId = uuidv7();
    const { PrismaService } = await import('../src/infra/prisma/prisma.service');
    const { EncryptionService } = await import('../src/common/crypto/encryption.service');
    const encryption = app.get(EncryptionService);
    const encrypted = await encryption.encrypt('1111222233');
    await app.get(PrismaService).artistPayoutMethod.create({
      data: {
        artistUserId: unverifiedArtistId,
        bankName: 'Test Bank',
        accountHolderName: 'Unverified Artist',
        accountNumberEncrypted: encrypted,
        branchCode: '123456',
        accountType: 'CHEQUE',
        isVerified: false,
      },
    });

    const { payoutId } = await seedReleasedHoldWithPayout({
      artistId: unverifiedArtistId,
      amountCents: 10_000,
      dispatchAfter: new Date(Date.now() - 60 * 60 * 1000),
    });

    const dispatcher = await getDispatcher();
    await dispatcher.runOnce();

    const payout = await prisma.payout.findUnique({ where: { id: payoutId } });
    expect(payout.state).toBe('FAILED');
    expect(payout.failureReason).toBe('PAYOUT_METHOD_NOT_VERIFIED');
    expect(payfastAdhocMock).not.toHaveBeenCalled();
  });

  it('dispatcher race guard: PROCESSING refund on same hold → payout SKIPPED, still QUEUED', async () => {
    const skipArtistId = uuidv7();
    const { PrismaService } = await import('../src/infra/prisma/prisma.service');
    const { EncryptionService } = await import('../src/common/crypto/encryption.service');
    const encryption = app.get(EncryptionService);
    const encrypted = await encryption.encrypt('4444555566');
    await app.get(PrismaService).artistPayoutMethod.create({
      data: {
        artistUserId: skipArtistId,
        bankName: 'Test Bank',
        accountHolderName: 'Skip Artist',
        accountNumberEncrypted: encrypted,
        branchCode: '123456',
        accountType: 'CHEQUE',
        isVerified: true,
        verifiedAt: new Date(),
        verifiedBy: adminId,
      },
    });

    const { payoutId, intentId } = await seedReleasedHoldWithPayout({
      artistId: skipArtistId,
      amountCents: 30_000,
      dispatchAfter: new Date(Date.now() - 60 * 60 * 1000),
    });

    // Seed a CHARGE txn + PROCESSING refund on the same intent so the race
    // guard fires.
    const charge = await prisma.transaction.create({
      data: {
        paymentIntentId: intentId,
        type: 'CHARGE',
        amountCents: 30_000n,
        currency: 'ZAR',
        gatewayTxnId: `pf-${uuidv7().slice(0, 8)}`,
        state: 'SUCCEEDED',
      },
    });
    await prisma.refund.create({
      data: {
        transactionId: charge.id,
        amountCents: 30_000n,
        initiatedBy: adminId,
        state: 'PROCESSING',
      },
    });

    payfastAdhocMock.mockResolvedValue({
      ok: true,
      payoutId: 'pf-payout-RACE',
      rawResponse: {},
    });

    const dispatcher = await getDispatcher();
    await dispatcher.runOnce();

    // Payout untouched.
    const payout = await prisma.payout.findUnique({ where: { id: payoutId } });
    expect(payout.state).toBe('QUEUED');
    expect(payfastAdhocMock).not.toHaveBeenCalled();
  });

  it('PayFast 5xx three times → payout FAILED after 3 retries, escrow.payout.failed outbox', async () => {
    const fiveXxArtistId = uuidv7();
    const { PrismaService } = await import('../src/infra/prisma/prisma.service');
    const { EncryptionService } = await import('../src/common/crypto/encryption.service');
    const encryption = app.get(EncryptionService);
    const encrypted = await encryption.encrypt('7777888899');
    await app.get(PrismaService).artistPayoutMethod.create({
      data: {
        artistUserId: fiveXxArtistId,
        bankName: 'Test Bank',
        accountHolderName: '5xx Artist',
        accountNumberEncrypted: encrypted,
        branchCode: '123456',
        accountType: 'CHEQUE',
        isVerified: true,
        verifiedAt: new Date(),
        verifiedBy: adminId,
      },
    });

    const { payoutId } = await seedReleasedHoldWithPayout({
      artistId: fiveXxArtistId,
      amountCents: 15_000,
      dispatchAfter: new Date(Date.now() - 60 * 60 * 1000),
    });

    payfastAdhocMock.mockResolvedValue({
      ok: false,
      retriable: true,
      status: 502,
      reason: 'Bad Gateway',
      rawResponse: { message: 'Bad Gateway' },
    });

    const dispatcher = await getDispatcher();
    await dispatcher.runOnce();

    expect(payfastAdhocMock).toHaveBeenCalledTimes(3);
    const payout = await prisma.payout.findUnique({ where: { id: payoutId } });
    expect(payout.state).toBe('FAILED');
    expect(payout.failureReason).toContain('Bad Gateway');
    expect(payout.attemptedAt).toBeTruthy();
    expect(payout.failedAt).toBeTruthy();

    const outbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: payoutId, eventType: 'escrow.payout.failed' },
    });
    expect(outbox).toHaveLength(1);
  });

  it('retry job: FAILED payout from 2h ago with attempts=0 → requeued', async () => {
    const retryArtistId = uuidv7();
    const { payoutId } = await seedReleasedHoldWithPayout({
      artistId: retryArtistId,
      amountCents: 10_000,
      dispatchAfter: new Date(Date.now() - 60 * 60 * 1000),
    });
    // Mark it FAILED 2h ago with attempts=0 (so backoff = 1h, eligible now).
    await prisma.payout.update({
      where: { id: payoutId },
      data: {
        state: 'FAILED',
        attempts: 0,
        failureReason: 'NO_PAYOUT_METHOD',
        failedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });

    const retryJob = await getRetryJob();
    const result = await retryJob.runOnce();

    expect((result as { requeued: number }).requeued).toBe(1);
    const refreshed = await prisma.payout.findUnique({ where: { id: payoutId } });
    expect(refreshed.state).toBe('QUEUED');
    expect(refreshed.attempts).toBe(1);
    expect(refreshed.failedAt).toBeNull();
  });

  it('retry job: FAILED payout from 10min ago with attempts=0 → NOT requeued (backoff not elapsed)', async () => {
    const earlyArtistId = uuidv7();
    const { payoutId } = await seedReleasedHoldWithPayout({
      artistId: earlyArtistId,
      amountCents: 10_000,
      dispatchAfter: new Date(Date.now() - 60 * 60 * 1000),
    });
    await prisma.payout.update({
      where: { id: payoutId },
      data: {
        state: 'FAILED',
        attempts: 0,
        failureReason: 'NO_PAYOUT_METHOD',
        failedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });

    const retryJob = await getRetryJob();
    await retryJob.runOnce();

    const refreshed = await prisma.payout.findUnique({ where: { id: payoutId } });
    expect(refreshed.state).toBe('FAILED');
  });

  it('admin retry route requeues a FAILED payout immediately', async () => {
    const adminRetryArtistId = uuidv7();
    const { payoutId } = await seedReleasedHoldWithPayout({
      artistId: adminRetryArtistId,
      amountCents: 5_000,
      dispatchAfter: new Date(Date.now() - 60 * 60 * 1000),
    });
    await prisma.payout.update({
      where: { id: payoutId },
      data: {
        state: 'FAILED',
        failureReason: 'NO_PAYOUT_METHOD',
        failedAt: new Date(),
      },
    });

    const res = await http
      .post(`/v1/admin/payouts/${payoutId}/retry`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.state).toBe('QUEUED');
    expect(res.body.attempts).toBe(1);
  });

  it('admin cancel route flips QUEUED → CANCELLED', async () => {
    const cancelArtistId = uuidv7();
    const { payoutId } = await seedReleasedHoldWithPayout({
      artistId: cancelArtistId,
      amountCents: 5_000,
      dispatchAfter: new Date(Date.now() + 60 * 60 * 1000), // future
    });

    const res = await http
      .post(`/v1/admin/payouts/${payoutId}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'redirected to refund' })
      .expect(200);
    expect(res.body.state).toBe('CANCELLED');
    expect(res.body.cancellationReason).toBe('redirected to refund');
  });
});
