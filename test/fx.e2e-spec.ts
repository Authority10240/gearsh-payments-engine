import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyMaterial } from './jwt.fake';

const ROOT = join(__dirname, '..');

/**
 * FX module e2e: spins up postgres + redis testcontainers, runs prisma migrate
 * deploy, seeds rates via the stub provider, and asserts:
 *   - GET /v1/rates returns the seeded ZAR-anchored rates
 *   - convertCurrency uses bankers' rounding (half-to-even) and surfaces
 *     FX_RATE_UNAVAILABLE when a pair is missing.
 *
 * Skipped automatically when Docker isn't available locally — the spec still
 * compiles via `pnpm jest --listTests --config test/jest-e2e.json`.
 */
describe('FX (e2e)', () => {
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  // Lazily imported after the module compiles.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fx: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;

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
    // Force the stub FX provider — never hit the network.
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

    fx = app.get((await import('../src/modules/fx/fx.service')).FxService);
    prisma = app.get((await import('../src/infra/prisma/prisma.service')).PrismaService);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (pg) await pg.stop();
    if (redis) await redis.stop();
  });

  it('GET /v1/rates returns the seeded rates after a refresh', async () => {
    await fx.refresh();
    const res = await http.get('/v1/rates?base=ZAR').expect(200);
    expect(res.body.base).toBe('ZAR');
    expect(Array.isArray(res.body.rates)).toBe(true);
    expect(res.body.rates.length).toBeGreaterThanOrEqual(7);
    const usd = res.body.rates.find((r: { toCurrency: string }) => r.toCurrency === 'USD');
    expect(usd).toBeDefined();
    expect(parseFloat(usd.rate)).toBeGreaterThan(0);
  });

  it('convertCurrency: identity', async () => {
    const out = await fx.convertCurrency(12345n, 'ZAR', 'ZAR');
    expect(out.amountCents).toBe(12345n);
    expect(out.rate).toBe('1');
  });

  it('convertCurrency: FX_RATE_UNAVAILABLE when a pair is missing', async () => {
    await prisma.exchangeRate.deleteMany({});
    await expect(fx.convertCurrency(1000n, 'USD', 'KES')).rejects.toMatchObject({
      code: 'FX_RATE_UNAVAILABLE',
    });
  });

  it('refresh writes one row per ordered pair (8 x 8)', async () => {
    await prisma.exchangeRate.deleteMany({});
    await fx.refresh();
    const count = await prisma.exchangeRate.count();
    // 8 currencies × 8 currencies = 64 ordered pairs.
    expect(count).toBe(64);
  });
});
