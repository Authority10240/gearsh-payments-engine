import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CloudEvent } from '../../cloud-event';
import type { EventHandler } from '../event-handler';
import { validateEventPayload } from '../payload-schemas';
import { RedisService } from '../../../infra/redis/redis.service';
import { APP_CONFIG } from '../../../config/app-config.token';
import type { AppConfig } from '../../../config/configuration';

/**
 * PAY-REPAIR-001 — populate the local admin sid denylist when Auth emits
 * `auth.session.revoked`.
 *
 * Subscribes via the new `payments-sub-auth-events` subscription (added to
 * env.validation PUBSUB_SUBSCRIPTIONS default in this commit). Filters to
 * ONLY `auth.session.revoked` — Payments has no other reason to consume
 * auth-events today, so this handler gets its own dedup space rather than
 * sharing with a fan-out sibling.
 *
 * Behaviour:
 *   - `scope: 'single'` carries a specific `sid` — SET
 *     `payments:sid:denylist:<sid>` with EX = max(60, JWT_ACCESS_TTL_SECONDS)
 *     so the entry can't outlive the access token it guards.
 *   - `scope: 'all'` (logout-all / admin revoke-all) has no single `sid`;
 *     log and ack. The defence on that path is Firebase refresh-token
 *     revocation in the Auth Engine.
 *
 * Idempotency: handler ID is `payments-auth-session-revoked`. Redelivery
 * just re-writes the same key with the same TTL.
 */
@Injectable()
export class AuthSessionRevokedHandler implements EventHandler {
  private readonly logger = new Logger(AuthSessionRevokedHandler.name);
  readonly consumerName = 'payments-auth-session-revoked';

  private static readonly DENYLIST_PREFIX = 'payments:sid:denylist:';
  private static readonly MIN_TTL_SECONDS = 60;

  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  handles(eventType: string): boolean {
    return eventType === 'auth.session.revoked';
  }

  async handle(event: CloudEvent): Promise<void> {
    validateEventPayload(event);
    const data = event.data as { userId: string; sid?: string; scope?: string };

    if (!data.sid) {
      this.logger.debug(
        `[${this.consumerName}] scope=${data.scope ?? 'unknown'} for user ${data.userId} — no sid to denylist; ack`,
      );
      return;
    }

    const ttl = Math.max(
      AuthSessionRevokedHandler.MIN_TTL_SECONDS,
      this.config.jwt.accessTtlSeconds,
    );
    const key = `${AuthSessionRevokedHandler.DENYLIST_PREFIX}${data.sid}`;
    await this.redis.set(key, '1', 'EX', ttl);
    this.logger.log(
      `[${this.consumerName}] denylisted sid=${data.sid} (user=${data.userId}, ttl=${ttl}s)`,
    );
  }
}
