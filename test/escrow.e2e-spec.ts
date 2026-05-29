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
 * PAY-003 escrow state machine + double-entry ledger e2e.
 *
 * Approach: seed HELD holds DIRECTLY via Prisma (rather than driving the full
 * PayFast ITN webhook for each case) — simpler + the webhook path is covered
 * by payfast-webhook.e2e-spec.ts. The escrow service is exercised through the
 * admin REST surface (POST /v1/escrow/holds/:id/...).
 *
 * Scenarios:
 *   - Release: HELD → RELEASED, payouts row queued with dispatch_after =
 *     now + DISPUTE_WINDOW_DAYS, ledger balanced, escrow.released outbox.
 *   - Refund (artist-fault): HELD → REFUNDED, 4 ledger entries (incl.
 *     PLATFORM_REVENUE reversal), escrow.refunded outbox with faultParty=ARTIST.
 *   - Partial refund × 2: state PARTIALLY_REFUNDED both times, running total,
 *     ledger balanced per event, 2 escrow.partially_refunded outbox rows.
 *   - Freeze: HELD with queued payout → DISPUTED, payout CANCELLED, escrow.frozen.
 *   - Resolve-split: DISPUTED → REFUNDED, ledger = 1 DEBIT + 2 CREDITS, ONE
 *     escrow.refunded outbox row with faultParty=SPLIT (convention §4 of report).
 *   - Illegal release on REFUNDED → 409 ESCROW_ILLEGAL_TRANSITION.
 *
 * Skips when Docker isn't available locally. Specs compile via
 * `pnpm jest --listTests --config test/jest-e2e.json`.
 */
describe('Escrow state machine + ledger (e2e)', () => {
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;

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

    adminToken = await signAccessToken(keys.privateKeyPem, { sub: adminId, roles: ['ADMIN'] });

    prisma = app.get((await import('../src/infra/prisma/prisma.service')).PrismaService);
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pg) await pg.stop();
    if (redis) await redis.stop();
  });

  // ── helpers ────────────────────────────────────────────────────────────

  /** Seed a HELD hold + the upstream payment_intent (PAY-002 normally writes
   *  these atomically with the ITN; for PAY-003 unit-style e2e we shortcut). */
  async function seedHeldHold(opts: {
    amountCents: number;
    platformFeeCents: number;
  }): Promise<{ holdId: string; bookingId: string; intentId: string }> {
    const bookingId = uuidv7();
    const subtotal = opts.amountCents; // simplification — held = subtotal in ZAR
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
    // Mirror PAY-002's HELD event (so audit + ledger have the prior write).
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
    return { holdId: hold.id, bookingId, intentId: intent.id };
  }

  function sumLedger(
    entries: Array<{ direction: string; amountCents: bigint | number }>,
    direction: 'DEBIT' | 'CREDIT',
  ): bigint {
    return entries
      .filter((e) => e.direction === direction)
      .reduce((s, e) => s + BigInt(e.amountCents), 0n);
  }

  // ── tests ──────────────────────────────────────────────────────────────

  it('release: HELD → RELEASED, payout queued, ledger balanced, outbox row', async () => {
    const { holdId } = await seedHeldHold({ amountCents: 200_000, platformFeeCents: 25_200 });

    const before = Date.now();
    const res = await http
      .post(`/v1/escrow/holds/${holdId}/release`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(200);

    expect(res.body.state).toBe('RELEASED');
    expect(res.body.releasedAt).toBeTruthy();

    const payouts = await prisma.payout.findMany({ where: { holdId } });
    expect(payouts).toHaveLength(1);
    expect(payouts[0].state).toBe('QUEUED');
    expect(Number(payouts[0].amountCents)).toBe(200_000);
    // dispatch_after ≈ released_at + 7 days
    const expectedDispatch = before + 7 * 24 * 60 * 60 * 1000;
    expect(payouts[0].dispatchAfter.getTime()).toBeGreaterThanOrEqual(expectedDispatch - 5_000);
    expect(payouts[0].dispatchAfter.getTime()).toBeLessThanOrEqual(
      expectedDispatch + 60 * 60 * 1000,
    );

    const events = await prisma.escrowEvent.findMany({
      where: { holdId, type: 'RELEASED' },
    });
    expect(events).toHaveLength(1);

    const ledger = await prisma.ledgerEntry.findMany({ where: { eventId: events[0].id } });
    expect(ledger).toHaveLength(2);
    expect(sumLedger(ledger, 'DEBIT')).toBe(sumLedger(ledger, 'CREDIT'));

    const outbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: holdId, eventType: 'escrow.released' },
    });
    expect(outbox).toHaveLength(1);
  });

  it('refund (artist-fault): HELD → REFUNDED, fee reversed, escrow.refunded outbox', async () => {
    const { holdId } = await seedHeldHold({ amountCents: 100_000, platformFeeCents: 12_600 });

    const res = await http
      .post(`/v1/escrow/holds/${holdId}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ faultParty: 'ARTIST', reason: 'no-show' })
      .expect(200);

    expect(res.body.state).toBe('REFUNDED');

    const events = await prisma.escrowEvent.findMany({
      where: { holdId, type: 'REFUNDED' },
    });
    expect(events).toHaveLength(1);

    // 4 entries: ESCROW_LIABILITY debit, REFUNDS_ISSUED credit, PLATFORM_REVENUE debit, REFUNDS_ISSUED credit.
    const ledger = await prisma.ledgerEntry.findMany({ where: { eventId: events[0].id } });
    expect(ledger).toHaveLength(4);
    expect(sumLedger(ledger, 'DEBIT')).toBe(sumLedger(ledger, 'CREDIT'));
    const revenueReversal = ledger.find(
      (e: { account: string; direction: string }) =>
        e.account === 'PLATFORM_REVENUE' && e.direction === 'DEBIT',
    );
    expect(revenueReversal).toBeTruthy();
    expect(Number(revenueReversal.amountCents)).toBe(12_600);

    const outbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: holdId, eventType: 'escrow.refunded' },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload.data.faultParty).toBe('ARTIST');
  });

  it('partial refund × 2: PARTIALLY_REFUNDED, running total, ledger balanced per event', async () => {
    const { holdId } = await seedHeldHold({ amountCents: 100_000, platformFeeCents: 12_600 });

    // First partial: 30 000
    await http
      .post(`/v1/escrow/holds/${holdId}/partial-refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amountCents: 30_000, reason: 'partial-1' })
      .expect(200);

    let hold = await prisma.escrowHold.findUnique({ where: { id: holdId } });
    expect(hold.state).toBe('PARTIALLY_REFUNDED');
    expect(Number(hold.partiallyRefundedAmountCents)).toBe(30_000);

    // Second partial: 20 000 → total 50 000
    await http
      .post(`/v1/escrow/holds/${holdId}/partial-refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amountCents: 20_000, reason: 'partial-2' })
      .expect(200);

    hold = await prisma.escrowHold.findUnique({ where: { id: holdId } });
    expect(hold.state).toBe('PARTIALLY_REFUNDED');
    expect(Number(hold.partiallyRefundedAmountCents)).toBe(50_000);

    const events = await prisma.escrowEvent.findMany({
      where: { holdId, type: 'PARTIALLY_REFUNDED' },
      orderBy: { createdAt: 'asc' },
    });
    expect(events).toHaveLength(2);

    for (const ev of events) {
      const ledger = await prisma.ledgerEntry.findMany({ where: { eventId: ev.id } });
      expect(ledger).toHaveLength(2); // no fee reversal on partials
      expect(sumLedger(ledger, 'DEBIT')).toBe(sumLedger(ledger, 'CREDIT'));
    }

    const outbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: holdId, eventType: 'escrow.partially_refunded' },
    });
    expect(outbox).toHaveLength(2);
  });

  it('freeze: queued payout cancelled, escrow.frozen outbox', async () => {
    const { holdId } = await seedHeldHold({ amountCents: 100_000, platformFeeCents: 12_600 });

    // Seed a QUEUED payout (would normally come from a prior release; we seed
    // it directly to simulate the "freeze after release attempted" path).
    await prisma.payout.create({
      data: {
        artistId,
        holdId,
        amountCents: 100_000n,
        currency: 'ZAR',
        state: 'QUEUED',
        dispatchAfter: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    await http
      .post(`/v1/escrow/holds/${holdId}/freeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'dispute-opened' })
      .expect(200);

    const hold = await prisma.escrowHold.findUnique({ where: { id: holdId } });
    expect(hold.state).toBe('DISPUTED');
    expect(hold.disputedAt).toBeTruthy();

    const payouts = await prisma.payout.findMany({ where: { holdId } });
    expect(payouts).toHaveLength(1);
    expect(payouts[0].state).toBe('CANCELLED');
    expect(payouts[0].cancellationReason).toBe('ESCROW_FROZEN');

    const outbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: holdId, eventType: 'escrow.frozen' },
    });
    expect(outbox).toHaveLength(1);
  });

  it('resolve-split: 1 DEBIT + 2 CREDITS that balance; ONE outbox row with faultParty=SPLIT', async () => {
    const { holdId } = await seedHeldHold({ amountCents: 100_000, platformFeeCents: 12_600 });
    // Move to DISPUTED first.
    await http
      .post(`/v1/escrow/holds/${holdId}/freeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'dispute' })
      .expect(200);

    await http
      .post(`/v1/escrow/holds/${holdId}/resolve-split`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ artistCents: 60_000, clientCents: 40_000, resolutionNotes: 'split' })
      .expect(200);

    const hold = await prisma.escrowHold.findUnique({ where: { id: holdId } });
    expect(hold.state).toBe('REFUNDED');

    const events = await prisma.escrowEvent.findMany({
      where: { holdId, type: 'RESOLVED_REFUND' },
    });
    expect(events).toHaveLength(1);

    const ledger = await prisma.ledgerEntry.findMany({ where: { eventId: events[0].id } });
    expect(ledger).toHaveLength(3);
    expect(ledger.filter((e: { direction: string }) => e.direction === 'DEBIT')).toHaveLength(1);
    expect(ledger.filter((e: { direction: string }) => e.direction === 'CREDIT')).toHaveLength(2);
    expect(sumLedger(ledger, 'DEBIT')).toBe(sumLedger(ledger, 'CREDIT'));

    const payouts = await prisma.payout.findMany({
      where: { holdId, state: 'QUEUED' },
    });
    expect(payouts).toHaveLength(1);
    expect(Number(payouts[0].amountCents)).toBe(60_000);

    const outbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: holdId, eventType: 'escrow.refunded' },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload.data.faultParty).toBe('SPLIT');
    expect(outbox[0].payload.data.splitArtistCents).toBe(60_000);
    expect(outbox[0].payload.data.splitClientCents).toBe(40_000);
  });

  it('illegal transition: release on REFUNDED → 409 ESCROW_ILLEGAL_TRANSITION', async () => {
    const { holdId } = await seedHeldHold({ amountCents: 50_000, platformFeeCents: 6_300 });

    // Full refund first.
    await http
      .post(`/v1/escrow/holds/${holdId}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ faultParty: 'CLIENT' })
      .expect(200);

    // Now release on a REFUNDED hold → 409.
    const res = await http
      .post(`/v1/escrow/holds/${holdId}/release`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(409);
    expect(res.body.code).toBe('ESCROW_ILLEGAL_TRANSITION');
  });

  it('resolve-split rejects amounts that do not sum to held amount', async () => {
    const { holdId } = await seedHeldHold({ amountCents: 50_000, platformFeeCents: 6_300 });
    await http
      .post(`/v1/escrow/holds/${holdId}/freeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'dispute' })
      .expect(200);

    const res = await http
      .post(`/v1/escrow/holds/${holdId}/resolve-split`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ artistCents: 25_000, clientCents: 24_999 })
      .expect(422);
    expect(res.body.code).toBe('BUSINESS_RULE_VIOLATION');
  });
});
