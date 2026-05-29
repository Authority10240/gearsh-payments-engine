import { Controller, Get, HttpCode, HttpStatus, Inject, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { APP_CONFIG } from '../config/app-config.token';
import type { AppConfig } from '../config/configuration';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisService } from '../infra/redis/redis.service';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('healthz')
  @HttpCode(200)
  @ApiOperation({ operationId: 'healthz', summary: 'Liveness probe (no dependencies)' })
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('readyz')
  @ApiOperation({ operationId: 'readyz', summary: 'Readiness probe (DB + Redis + Pub/Sub)' })
  async readiness(@Res() res: Response): Promise<void> {
    const checks: Record<string, 'up' | 'down'> = { db: 'down', redis: 'down', pubsub: 'down' };

    try {
      await this.prisma.ping();
      checks.db = 'up';
    } catch {
      /* leave down */
    }

    try {
      await this.redis.healthPing();
      checks.redis = 'up';
    } catch {
      /* leave down */
    }

    // Pub/Sub readiness: when disabled we report 'up' (the bus is intentionally
    // off); when enabled, a configured project id is treated as reachable for
    // the bootstrap. A live ping comes with PAY-002+ once topics exist.
    checks.pubsub =
      !this.config.pubsub.enabled || Boolean(this.config.pubsub.projectId) ? 'up' : 'down';

    const ready = checks.db === 'up' && checks.redis === 'up' && checks.pubsub === 'up';
    res
      .status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json({ status: ready ? 'ready' : 'not_ready', checks });
  }
}
