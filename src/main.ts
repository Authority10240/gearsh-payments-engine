import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { APP_CONFIG } from './config/app-config.token';
import type { AppConfig } from './config/configuration';
import { validationExceptionFactory } from './common/problem/validation';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.flushLogs();

  const config = app.get<AppConfig>(APP_CONFIG);
  const log = app.get(Logger);

  // Cloud Run / Cloud Armor terminates TLS upstream; trust the first proxy hop
  // so `req.ip` returns the original client IP (PayFast → /v1/webhooks/payfast
  // IP whitelist check, PAY-002 step 1). See Express "trust proxy" docs.
  app.set('trust proxy', 1);

  // Security headers. CSP disabled so the self-hosted Swagger UI loads; the
  // edge (Cloud Armor) enforces the production CSP.
  app.use(helmet({ contentSecurityPolicy: false }));

  app.enableCors({
    origin: config.cors.allowedOrigins.length > 0 ? config.cors.allowedOrigins : false,
    credentials: false,
    maxAge: 600,
  });

  // PayFast posts the ITN as application/x-www-form-urlencoded — make sure
  // body parsing is enabled for it. JSON parsing for the rest.
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );

  app.enableShutdownHooks();

  const docConfig = new DocumentBuilder()
    .setTitle('Gearsh Payments Engine')
    .setDescription(
      'Cart, checkout, PayFast gateway, escrow ledger, refunds, artist payouts. All money movement in one service.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .addApiKey(
      { type: 'apiKey', in: 'header', name: 'X-Internal-Service-Token' },
      'internalServiceAuth',
    )
    .addServer(`http://localhost:${config.port}`)
    .build();
  const document = SwaggerModule.createDocument(app, docConfig);
  SwaggerModule.setup('v1/docs', app, document, {
    jsonDocumentUrl: 'v1/docs-json',
  });

  await app.listen(config.port, '0.0.0.0');
  log.log(`gearsh-payments-engine listening on :${config.port} (env=${config.env})`, 'Bootstrap');
  log.log(`Swagger UI at http://localhost:${config.port}/v1/docs`, 'Bootstrap');
}

void bootstrap();
