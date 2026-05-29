import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../../config/app-config.token';
import type { AppConfig } from '../../config/configuration';

/**
 * ioredis-backed Redis client. Payments uses Redis for the 24h
 * `Idempotency-Key` dedup (conventions §11) and for caches (admin session
 * denylist; FX rate hot cache later).
 *
 * `lazyConnect` keeps boot resilient: the client connects on first use and the
 * /readyz probe surfaces connectivity via ping().
 */
@Injectable()
export class RedisService extends Redis implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super(config.redis.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    this.on('error', (err) => this.logger.warn(`Redis error: ${err.message}`));
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.connect();
      this.logger.log('Redis connected');
    } catch (err) {
      // Non-fatal at boot: /readyz reports not-ready until Redis is reachable.
      this.logger.warn(`Redis connect failed at boot: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.disconnect();
  }

  /** Readiness probe used by /readyz. Throws if Redis is unreachable. */
  async healthPing(): Promise<void> {
    const pong = await this.ping();
    if (pong !== 'PONG') throw new Error(`unexpected ping reply: ${pong}`);
  }
}
