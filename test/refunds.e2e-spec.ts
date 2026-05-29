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
 * PAY-004 refunds API end-to-end.
 *
 * Strategy: seed an intent + a CHARGE transaction + HELD escrow hold + the
 * matching PAY-002 HELD escrow event + balanced ledger entries directly via
 * Prisma (mirrors the escrow.e2e-spec PAY-003 seed). The PayFast Refund API
 * round-trip is mocked at the PayFastClient.refund layer via the Nest test
 * module's `.overrideProvider` so we don't hit a live PayFast.
 *
 * Scenarios covered:
 *   - Full refund (CLIENT-fault): SUCCEEDED row, hold REFUNDED, 2 ledger
 *     entries (NO PLATFORM_REVENUE reversal — §8.5), escrow_event.refund_id
 *     linked, both payments.refund.succeeded + escrow.refunded outbox rows.
 *   - Partial refund: state PARTIALLY_REFUNDED, running total, escrow.partially_refunded
 *     outbox row.
 *   - Full refund on a REFUNDED hold → 409 ILLEGAL_TRANSITION.
 *   - refundCents > available → 422 REFUND_EXCEEDS_CAPTURE.
 *   - Artist-fault full refund: 4 ledger entries with PLATFORM_REVENUE
 *     reversal, faultParty=ARTIST on both outbox rows.
 *   - PayFast 5xx (mocked) → refund row FAILED, hold unchanged, only
 *     payments.refund.failed outbox row, 502 to caller.
 */
describe('Refunds API + PayFast Refund (e2e)', () => {
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // The mock holder — replaced per-test to control success/failure.
  const payfastRefundMock = jest.fn();

  let adminToken: string;
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
    // Configure PayFast as enabled so PayFastClient.assertEnabled passes in
    // any other code path — but PayFastClient.refund() itself is overridden
    // via the test module so no live HTTP call happens.
    process.env.PAYFAST_MERCHANT_ID = '10000100';
    process.env.PAYFAST_MERCHANT_KEY = '46f0cd694581a';
    process.env.PAYFAST_PASSPHRASE = 'jt7NOE43FZPn';
    process.env.PAYFAST_PROCESS_URL = 'https://sandbox.payfast.co.za/eng/process';
    process.env.PAYFAST_REFUND_URL = 'https://api.payfast.co.za/refunds/{pf_payment_id}';
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
        // Methods consumed by RefundsService:
        refund: payfastRefundMock,
        // Other methods left as harmless no-ops so DI of PayFastClient elsewhere
        // (PayFastWebhookService) still compiles. Not exercised by these specs.
        enabled: true,
        buildCheckoutForm: jest.fn(),
        verifyItnSignature: jest.fn(),
        validateItn: jest.fn(),
        adhocPayment: jest.fn(),
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
    prisma = app.get((await import('../src/infra/prisma/prisma.service')).PrismaService);
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pg) await pg.stop();
    if (redis) await redis.stop();
  });

  beforeEach(() => {
    payfastRefundMock.mockReset();
  });

  // ── helpers ────────────────────────────────────────────────────────────

  /** Seed a HELD hold + CHARGE transaction + PAY-002 HELD escrow event +
   *  balanced ledger entries. Mirrors escrow.e2e-spec.seedHeldHold but ALSO
   *  writes the CHARGE transaction (RefundsService.resolveHoldAndCharge
   *  needs it for the pf_payment_id). */
  async function seedHeldWithCharge(opts: {
    amountCents: number;
    platformFeeCents: number;
  }): Promise<{
    holdId: string;
    bookingId: string;
    intentId: string;
    chargeTxnId: string;
    pfPaymentId: string;
  }> {
    const bookingId = uuidv7();
    const subtotal = opts.amountCents;
    const total = subtotal + opts.platformFeeCents;
    const intent = await prisma.paymentIntent.create({
      data: {
        bookingId,
        userId: clientId,
        artistId,
        subtotalCents: BigInt(subtotal),
        serviceFeeCents: BigInt(opts.platformFeeCents),
        totalCents: BigInt(total),
        currency: 'ZAR',
        clientCurrency: 'ZAR',
        state: 'SUCCEEDED',
        zarAmountCentsLocked: BigInt(total),
        zarServiceFeeCentsLocked: BigInt(opts.platformFeeCents),
      },
    });
    const pfPaymentId = `pf-${uuidv7().slice(0, 8)}`;
    const charge = await prisma.transaction.create({
      data: {
        paymentIntentId: intent.id,
        type: 'CHARGE',
        amountCents: BigInt(total),
        currency: 'ZAR',
        gatewayTxnId: pfPaymentId,
        pfPaymentStatus: 'COMPLETE',
        state: 'SUCCEEDED',
      },
    });
    const hold = await prisma.escrowHold.create({
      data: {
        bookingId,
        paymentIntentId: intent.id,
        clientId,
        artistId,
        amountCents: BigInt(opts.amountCents),
        platformFeeCents: BigInt(opts.platformFeeCents),
        currency: 'ZAR',
        state: 'HELD',
      },
    });
    const event = await prisma.escrowEvent.create({
      data: {
        holdId: hold.id,
        type: 'HELD',
        amountCents: BigInt(opts.amountCents),
        note: 'seeded',
      },
    });
    await prisma.ledgerEntry.createMany({
      data: [
        {
          holdId: hold.id,
          eventId: event.id,
          account: 'PAYFAST_SETTLEMENT',
          direction: 'DEBIT',
          amountCents: BigInt(total),
          currency: 'ZAR',
        },
        {
          holdId: hold.id,
          eventId: event.id,
          account: 'ESCROW_LIABILITY',
          direction: 'CREDIT',
          amountCents: BigInt(opts.amountCents),
          currency: 'ZAR',
        },
        {
          holdId: hold.id,
          eventId: event.id,
          account: 'PLATFORM_REVENUE',
          direction: 'CREDIT',
          amountCents: BigInt(opts.platformFeeCents),
          currency: 'ZAR',
        },
      ],
    });
    return {
      holdId: hold.id,
      bookingId,
      intentId: intent.id,
      chargeTxnId: charge.id,
      pfPaymentId,
    };
  }

  function sumLedger(
    entries: Array<{ direction: string; amountCents: bigint | number }>,
    direction: 'DEBIT' | 'CREDIT',
  ): bigint {
    return entries
      .filter((e) => e.direction === direction)
      .reduce((s, e) => s + BigInt(e.amountCents), 0n);
  }

  function mockPayFastSuccess(refundId = 'pf-refund-OK'): void {
    payfastRefundMock.mockResolvedValue({
      ok: true,
      refundId,
      rawResponse: { refund_id: refundId },
    });
  }
  function mockPayFast5xx(): void {
    payfastRefundMock.mockResolvedValue({
      ok: false,
      retriable: true,
      status: 502,
      reason: 'Bad Gateway',
      rawResponse: { message: 'Bad Gateway' },
    });
  }

  // ── tests ──────────────────────────────────────────────────────────────

  it('CLIENT-fault full refund → REFUNDED, escrow_event linked to refund, 2 ledger entries (no fee reversal)', async () => {
    const { holdId } = await seedHeldWithCharge({
      amountCents: 200_000,
      platformFeeCents: 25_200,
    });
    mockPayFastSuccess('pf-refund-client');

    const res = await http
      .post('/v1/refunds')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        holdId,
        full: true,
        reason: 'client cancellation',
        faultParty: 'CLIENT',
      })
      .expect(201);

    expect(res.body.state).toBe('SUCCEEDED');
    expect(res.body.gatewayRefundId).toBe('pf-refund-client');
    expect(res.body.completedAt).toBeTruthy();

    const refundId = res.body.id;

    // Hold flipped to REFUNDED.
    const hold = await prisma.escrowHold.findUnique({ where: { id: holdId } });
    expect(hold.state).toBe('REFUNDED');

    // escrow_events row carries the refund_id back-reference.
    const event = await prisma.escrowEvent.findFirst({
      where: { holdId, type: 'REFUNDED' },
    });
    expect(event).toBeTruthy();
    expect(event.refundId).toBe(refundId);

    // 2 ledger entries (DEBIT ESCROW_LIABILITY, CREDIT REFUNDS_ISSUED) — fee
    // NOT reversed since CLIENT-fault.
    const ledger = await prisma.ledgerEntry.findMany({ where: { eventId: event.id } });
    expect(ledger).toHaveLength(2);
    expect(sumLedger(ledger, 'DEBIT')).toBe(sumLedger(ledger, 'CREDIT'));
    expect(
      ledger.find(
        (e: { account: string; direction: string }) =>
          e.account === 'PLATFORM_REVENUE' && e.direction === 'DEBIT',
      ),
    ).toBeUndefined();

    // Outbox: payments.refund.succeeded + escrow.refunded (both per the spec).
    const refundOutbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: refundId, eventType: 'payments.refund.succeeded' },
    });
    expect(refundOutbox).toHaveLength(1);
    expect(refundOutbox[0].payload.data.gatewayRefundId).toBe('pf-refund-client');

    const escrowOutbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: holdId, eventType: 'escrow.refunded' },
    });
    expect(escrowOutbox).toHaveLength(1);
    expect(escrowOutbox[0].payload.data.faultParty).toBe('CLIENT');

    // PayFast call: amountCents == hold.amountCents (full = 200_000).
    expect(payfastRefundMock).toHaveBeenCalledTimes(1);
    const call = payfastRefundMock.mock.calls[0][0] as { amountCents: bigint };
    expect(call.amountCents).toBe(200_000n);
  });

  it('ARTIST-fault full refund → 4 ledger entries (PLATFORM_REVENUE reversed)', async () => {
    const { holdId } = await seedHeldWithCharge({
      amountCents: 100_000,
      platformFeeCents: 12_600,
    });
    mockPayFastSuccess('pf-refund-artist');

    const res = await http
      .post('/v1/refunds')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        holdId,
        full: true,
        reason: 'artist no-show',
        faultParty: 'ARTIST',
      })
      .expect(201);

    const refundId = res.body.id;
    const event = await prisma.escrowEvent.findFirst({
      where: { holdId, type: 'REFUNDED' },
    });
    expect(event.refundId).toBe(refundId);

    const ledger = await prisma.ledgerEntry.findMany({ where: { eventId: event.id } });
    expect(ledger).toHaveLength(4); // 2 standard + 2 fee reversal
    expect(sumLedger(ledger, 'DEBIT')).toBe(sumLedger(ledger, 'CREDIT'));
    const revenueReversal = ledger.find(
      (e: { account: string; direction: string }) =>
        e.account === 'PLATFORM_REVENUE' && e.direction === 'DEBIT',
    );
    expect(revenueReversal).toBeTruthy();
    expect(Number(revenueReversal.amountCents)).toBe(12_600);

    // Both outbox rows have faultParty=ARTIST.
    const refundOutbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: refundId, eventType: 'payments.refund.succeeded' },
    });
    expect(refundOutbox[0].payload.data.faultParty).toBe('ARTIST');
    const escrowOutbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: holdId, eventType: 'escrow.refunded' },
    });
    expect(escrowOutbox[0].payload.data.faultParty).toBe('ARTIST');
  });

  it('partial refund → PARTIALLY_REFUNDED, running total, escrow.partially_refunded outbox', async () => {
    const { holdId } = await seedHeldWithCharge({
      amountCents: 100_000,
      platformFeeCents: 12_600,
    });
    mockPayFastSuccess('pf-refund-partial');

    const res = await http
      .post('/v1/refunds')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        holdId,
        refundCents: 40_000,
        reason: 'partial only',
        faultParty: 'CLIENT',
      })
      .expect(201);

    expect(res.body.state).toBe('SUCCEEDED');
    expect(res.body.amountCents).toBe(40_000);

    const hold = await prisma.escrowHold.findUnique({ where: { id: holdId } });
    expect(hold.state).toBe('PARTIALLY_REFUNDED');
    expect(Number(hold.partiallyRefundedAmountCents)).toBe(40_000);

    const event = await prisma.escrowEvent.findFirst({
      where: { holdId, type: 'PARTIALLY_REFUNDED' },
    });
    expect(event.refundId).toBe(res.body.id);

    const escrowOutbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: holdId, eventType: 'escrow.partially_refunded' },
    });
    expect(escrowOutbox).toHaveLength(1);
  });

  it('full refund on a REFUNDED hold → 409 ILLEGAL_TRANSITION', async () => {
    const { holdId } = await seedHeldWithCharge({
      amountCents: 50_000,
      platformFeeCents: 6_300,
    });
    mockPayFastSuccess('pf-refund-first');

    // First refund succeeds.
    await http
      .post('/v1/refunds')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ holdId, full: true, reason: 'first', faultParty: 'CLIENT' })
      .expect(201);

    // Reset the mock so we'd "succeed" again at PayFast if we got past the
    // pre-flight — proving the 409 comes from the state-machine check, not
    // from the gateway.
    payfastRefundMock.mockReset();
    mockPayFastSuccess('pf-refund-second');

    const res = await http
      .post('/v1/refunds')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ holdId, full: true, reason: 'second', faultParty: 'CLIENT' })
      .expect(409);
    expect(res.body.code).toBe('ILLEGAL_TRANSITION');
    // PayFast was NOT called the second time.
    expect(payfastRefundMock).not.toHaveBeenCalled();
  });

  it('refundCents > available → 422 REFUND_EXCEEDS_CAPTURE, PayFast NOT called', async () => {
    const { holdId } = await seedHeldWithCharge({
      amountCents: 50_000,
      platformFeeCents: 6_300,
    });
    mockPayFastSuccess();

    const res = await http
      .post('/v1/refunds')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ holdId, refundCents: 100_000, reason: 'over', faultParty: 'CLIENT' })
      .expect(422);
    expect(res.body.code).toBe('REFUND_EXCEEDS_CAPTURE');
    expect(payfastRefundMock).not.toHaveBeenCalled();
  });

  it('PayFast 5xx → refund FAILED, hold unchanged, payments.refund.failed outbox, 502 to caller', async () => {
    const { holdId } = await seedHeldWithCharge({
      amountCents: 80_000,
      platformFeeCents: 10_080,
    });
    mockPayFast5xx();

    const res = await http
      .post('/v1/refunds')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ holdId, full: true, reason: 'gateway-down', faultParty: 'CLIENT' })
      .expect(502);
    expect(res.body.code).toBe('PAYFAST_UPSTREAM_FAILURE');

    // PayFast was called 3 times (the retry budget).
    expect(payfastRefundMock).toHaveBeenCalledTimes(3);

    // Hold unchanged.
    const hold = await prisma.escrowHold.findUnique({ where: { id: holdId } });
    expect(hold.state).toBe('HELD');

    // No new REFUNDED / PARTIALLY_REFUNDED escrow event.
    const events = await prisma.escrowEvent.findMany({
      where: { holdId, type: { in: ['REFUNDED', 'PARTIALLY_REFUNDED'] } },
    });
    expect(events).toHaveLength(0);

    // refunds row FAILED.
    const refunds = await prisma.refund.findMany({});
    const fail = refunds.find((r: { state: string; failureReason: string | null }) =>
      r.failureReason?.includes('Bad Gateway'),
    );
    expect(fail).toBeTruthy();
    expect(fail.state).toBe('FAILED');

    // payments.refund.failed outbox row.
    const refundOutbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: fail.id, eventType: 'payments.refund.failed' },
    });
    expect(refundOutbox).toHaveLength(1);
    // No escrow.refunded for this hold.
    const escrowOutbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: holdId, eventType: 'escrow.refunded' },
    });
    expect(escrowOutbox).toHaveLength(0);
  });

  it('GET /v1/refunds/eligibility/:holdId returns canRefund=true with max for a HELD hold', async () => {
    const { holdId } = await seedHeldWithCharge({
      amountCents: 60_000,
      platformFeeCents: 7_560,
    });
    const res = await http
      .get(`/v1/refunds/eligibility/${holdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.canRefund).toBe(true);
    expect(res.body.maxRefundableCents).toBe(60_000);
    expect(res.body.reason).toBeNull();
  });
});
