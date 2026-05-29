import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
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
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { ProblemFilter } from './common/problem/problem.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { InternalServiceGuard } from './common/guards/internal-service.guard';
import { HealthModule } from './health/health.module';
import { FxModule } from './modules/fx/fx.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { EscrowModule } from './modules/escrow/escrow.module';

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
    HealthModule,
    FxModule,
    PaymentsModule,
    EscrowModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: InternalServiceGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
