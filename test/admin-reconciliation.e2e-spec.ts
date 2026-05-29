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
 * PAY-007 e2e — covers:
 *
 *   1. ReconciliationService.runForDate against seeded data writes a
 *      reconciliation_runs row with the expected findings count.
 *   2. An imbalanced ledger entry trips an INVARIANT_A_EVENT_IMBALANCE finding.
 *   3. Admin composite endpoints respond 200 for admin tokens, 403
 *      (ADMIN_REQUIRED) for non-admin tokens.
 *   4. Each admin call writes an `admin_audit_log` row with the expected
 *      method/path/actorId/responseCode.
 *   5. The audit middleware redacts `accountNumber` from the request body.
 *
 * Seeds the ledger directly with Prisma — the escrow service is already
 * covered by escrow.e2e-spec.ts; we only need balanced + intentionally-broken
 * fixtures here.
 */
describe('PAY-007: admin reconciliation + audit (e2e)', () => {
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;

  let adminToken: string;
  let clientToken: string;
  const adminId = uuidv7();
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
    process.env.PAYOUT_DISPATCH_ENABLED = 'false';
    process.env.PAYOUT_RETRY_ENABLED = 'false';
    process.env.RECONCILIATION_ENABLED = 'false';
    process.env.RECONCILIATION_ALERT_THRESHOLD_CENTS = '1000';
    process.env.STUCK_HOLD_HOURS = '72';
    process.env.STUCK_PAYOUT_HOURS = '24';
    process.env.STUCK_DISPUTE_DAYS = '14';
    delete process.env.PAYFAST_MERCHANT_ID;
    delete process.env.PAYFAST_MERCHANT_KEY;
    delete process.env.PAYFAST_PASSPHRASE;
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
    clientToken = await signAccessToken(keys.privateKeyPem, { sub: clientId, roles: ['CLIENT'] });

    prisma = app.get((await import('../src/infra/prisma/prisma.service')).PrismaService);
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pg) await pg.stop();
    if (redis) await redis.stop();
  });

  beforeEach(async () => {
    // Clear audit log between tests so the row-count assertions stay clean.
    await prisma.adminAuditLog.deleteMany();
  });

  // ── helpers ────────────────────────────────────────────────────────────

  async function seedBalancedHeld(opts: { amountCents: number; platformFeeCents: number }) {
    const bookingId = uuidv7();
    const total = opts.amountCents + opts.platformFeeCents;
    const intent = await prisma.paymentIntent.create({
      data: {
        bookingId,
        userId: clientId,
        artistId,
        subtotalCents: BigInt(opts.amountCents),
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
    const event = await prisma.escrowEvent.create({
      data: {
        holdId: hold.id,
        type: 'HELD',
        amountCents: BigInt(opts.amountCents),
        note: 'e2e-seed',
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
    return { holdId: hold.id, eventId: event.id };
  }

  /** Wait for the fire-and-forget audit write (setImmediate) to land. */
  async function waitForAuditRow(matcher: { method: string; path: string }, maxMs = 2_000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const row = await prisma.adminAuditLog.findFirst({
        where: { method: matcher.method, path: matcher.path },
        orderBy: { createdAt: 'desc' },
      });
      if (row) return row;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`audit row not written for ${matcher.method} ${matcher.path}`);
  }

  // ── reconciliation cron + service ──────────────────────────────────────

  it('reconciliation cron runs against seeded data and writes a reconciliation_runs row', async () => {
    await seedBalancedHeld({ amountCents: 100_000, platformFeeCents: 12_600 });
    await seedBalancedHeld({ amountCents: 50_000, platformFeeCents: 6_300 });

    const { ReconciliationJob } =
      await import('../src/modules/reconciliation/jobs/reconciliation.job');
    const job = app.get(ReconciliationJob);
    const outcome = await job.runOnce();

    expect(outcome.runId).toBeTruthy();
    expect(outcome.state).toBe('COMPLETED');

    const run = await prisma.reconciliationRun.findUnique({ where: { id: outcome.runId } });
    expect(run).toBeTruthy();
    expect(run.state).toBe('COMPLETED');
    // PayFast not configured + balanced ledger → expect INFO finding only,
    // no HIGH alert.
    expect(run.alertSent).toBe(false);
    const findings = run.findings as Array<{ code: string; severity: string }>;
    expect(findings.some((f) => f.code === 'PAYFAST_RECONCILIATION_SKIPPED')).toBe(true);
    expect(findings.every((f) => f.severity !== 'HIGH')).toBe(true);
  });

  it('injecting an imbalanced ledger entry raises an INVARIANT_A finding', async () => {
    const { eventId, holdId } = await seedBalancedHeld({
      amountCents: 100_000,
      platformFeeCents: 12_600,
    });
    // Add a stray CREDIT WITHOUT a matching DEBIT in the same event — invariant A
    // walks ledger entries created in the day's window so this lands in scope.
    await prisma.ledgerEntry.create({
      data: {
        holdId,
        eventId,
        account: 'PLATFORM_REVENUE',
        direction: 'CREDIT',
        amountCents: 1n,
        currency: 'ZAR',
      },
    });

    const { ReconciliationService } =
      await import('../src/modules/reconciliation/reconciliation.service');
    const service = app.get(ReconciliationService);
    const outcome = await service.runForDate(new Date());
    expect(outcome.alertSent).toBe(true);

    const run = await prisma.reconciliationRun.findUnique({ where: { id: outcome.runId } });
    const findings = run.findings as Array<{ code: string; severity: string }>;
    expect(
      findings.some((f) => f.code === 'INVARIANT_A_EVENT_IMBALANCE' && f.severity === 'HIGH'),
    ).toBe(true);
  });

  // ── admin composite endpoints + audit ──────────────────────────────────

  it('GET /v1/admin/escrow/balances → 200 for admin + writes an audit row', async () => {
    const res = await http
      .get('/v1/admin/escrow/balances')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((b: { account: string }) => b.account === 'ESCROW_LIABILITY')).toBe(
      true,
    );

    const audit = await waitForAuditRow({ method: 'GET', path: '/v1/admin/escrow/balances' });
    expect(audit.actorId).toBe(adminId);
    expect(audit.responseCode).toBe(200);
    expect(audit.action).toContain('admin.escrow.balances.get');
  });

  it('GET /v1/admin/escrow/balances → 403 ADMIN_REQUIRED for non-admin (and still audits)', async () => {
    const res = await http
      .get('/v1/admin/escrow/balances')
      .set('Authorization', `Bearer ${clientToken}`)
      .expect(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');

    const audit = await waitForAuditRow({ method: 'GET', path: '/v1/admin/escrow/balances' });
    expect(audit.actorId).toBe(clientId);
    expect(audit.responseCode).toBe(403);
  });

  it('GET /v1/admin/payments/transactions → cursor-paginated list (admin)', async () => {
    await seedBalancedHeld({ amountCents: 25_000, platformFeeCents: 3_150 });
    const res = await http
      .get('/v1/admin/payments/transactions?limit=10')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.pageInfo).toBeDefined();

    await waitForAuditRow({ method: 'GET', path: '/v1/admin/payments/transactions' });
  });

  it('GET /v1/admin/reconciliation/stuck/holds → returns rows older than threshold', async () => {
    // Seed a hold older than STUCK_HOLD_HOURS (72h).
    const bookingId = uuidv7();
    const intent = await prisma.paymentIntent.create({
      data: {
        bookingId,
        userId: clientId,
        artistId,
        subtotalCents: 5_000n,
        serviceFeeCents: 630n,
        totalCents: 5_630n,
        currency: 'ZAR',
        clientCurrency: 'ZAR',
        state: 'SUCCEEDED',
      },
    });
    const stale = new Date(Date.now() - 100 * 60 * 60 * 1000); // 100h ago
    await prisma.escrowHold.create({
      data: {
        bookingId,
        paymentIntentId: intent.id,
        clientId,
        artistId,
        amountCents: 5_000n,
        platformFeeCents: 630n,
        currency: 'ZAR',
        state: 'HELD',
        heldAt: stale,
        createdAt: stale,
      },
    });

    const res = await http
      .get('/v1/admin/reconciliation/stuck/holds')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.thresholdHours).toBe(72);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /v1/admin/reconciliation/run returns a runId immediately (admin trigger)', async () => {
    const res = await http
      .post('/v1/admin/reconciliation/run')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(202);
    expect(res.body.runId).toBeTruthy();

    const run = await prisma.reconciliationRun.findUnique({ where: { id: res.body.runId } });
    expect(run.state).toBe('COMPLETED');
  });

  it('audit middleware redacts accountNumber from the request body', async () => {
    // Use the artist payout method PUT (existing PAY-005 admin-adjacent route)
    // because it has an `accountNumber` field. The route lives under
    // /v1/payouts/method (not /v1/admin/*) so we exercise the audit middleware
    // directly via /v1/admin/payouts/:id/cancel with an `accountNumber` field
    // smuggled into the body (DTOs are whitelisted but the audit middleware
    // captures `req.body` BEFORE pipe transforms strip unknown keys).
    //
    // Simpler approach: POST /v1/admin/reconciliation/run with an extra body
    // key. The DTO has no body fields (asOfDate is a query param), so we use
    // the trigger endpoint as the carrier.
    //
    // We POST to a /v1/admin/* route with the redactable payload AND assert
    // the audit row's request_body is the redacted projection. Use the audit
    // middleware redaction unit test as the source of truth for the in-mem
    // contract; here we lock down the persisted JSON.
    await http
      .post('/v1/admin/reconciliation/run')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Content-Type', 'application/json')
      .send({ accountNumber: '1234567890', notes: 'manual trigger' })
      .expect(202);

    const audit = await waitForAuditRow({
      method: 'POST',
      path: '/v1/admin/reconciliation/run',
    });
    const body = audit.requestBody as Record<string, unknown> | null;
    expect(body).toBeTruthy();
    expect(body!.accountNumber).toBe('[REDACTED]');
    // `notes` is non-sensitive so it remains, but its short string value
    // (< 8 digits) stays as-is.
    expect(body!.notes).toBe('manual trigger');
  });

  it('audit row records the response code on 403 admin rejections', async () => {
    await http.get('/v1/admin/audit').set('Authorization', `Bearer ${clientToken}`).expect(403);

    const audit = await waitForAuditRow({ method: 'GET', path: '/v1/admin/audit' });
    expect(audit.responseCode).toBe(403);
    expect(audit.actorId).toBe(clientId);
  });
});
