import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { AppConfigModule, APP_CONFIG } from './config/config.module';
import type { AppConfig } from './config/configuration';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { PayFastModule } from './infra/payfast/payfast.module';
import { ExchangeRatesModule } from './infra/exchange-rates/exchange-rates.module';
import { EventsModule } from './events/events.module';
import { SecurityModule } from './common/security.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { ProblemFilter } from './common/problem/problem.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { InternalServiceGuard } from './common/guards/internal-service.guard';
import { HealthModule } from './health/health.module';
import { FxModule } from './modules/fx/fx.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { EscrowModule } from './modules/escrow/escrow.module';
import { RefundsModule } from './modules/refunds/refunds.module';
import { PayoutsModule } from './modules/payouts/payouts.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';
import { AdminModule } from './modules/admin/admin.module';
import { AdminAuditMiddleware } from './modules/admin/audit.middleware';
import { AuditActionInterceptor } from './modules/admin/audit-action.interceptor';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logLevel,
          name: config.serviceName,
          genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
          customProps: (req) => {
            const r = req as unknown as { requestId?: string; traceparent?: string };
            return { service: config.serviceName, requestId: r.requestId, traceId: r.traceparent };
          },
          // Never log credentials, tokens or PayFast secrets (conventions §15).
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-internal-service-token"]',
              'req.headers["idempotency-key"]',
              'req.body.signature',
              'req.body.passphrase',
            ],
            remove: true,
          },
          transport:
            config.env === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.rateLimit.ttlSeconds * 1000,
            limit: config.rateLimit.perIp,
          },
        ],
      }),
    }),
    PrismaModule,
    RedisModule,
    PayFastModule,
    ExchangeRatesModule,
    EventsModule,
    SecurityModule,
    CryptoModule,
    HealthModule,
    FxModule,
    PaymentsModule,
    EscrowModule,
    RefundsModule,
    PayoutsModule,
    ReconciliationModule,
    AdminModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: InternalServiceGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Reads `@AuditAction(...)` metadata on the matched handler and stamps it
    // onto `req.auditAction` for AdminAuditMiddleware to pick up on
    // res.finish (PAY-007). No-op on routes without the decorator.
    { provide: APP_INTERCEPTOR, useClass: AuditActionInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
    // Audit middleware applies ONLY to the admin surface. It runs AFTER the
    // global JwtAuthGuard so `req.user` is already attached; the middleware
    // bails when there is no resolved subject (401 paths are not audited).
    // PAY-007 — covers `/v1/admin/*` from EVERY module, including the
    // already-existing AdminPayoutsController.
    consumer.apply(AdminAuditMiddleware).forRoutes('v1/admin/*');
  }
}
