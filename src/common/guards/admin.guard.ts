import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { RedisService } from '../../infra/redis/redis.service';
import { AppException } from '../problem/app-exception';
import { ErrorCode } from '../problem/error-codes';

/** Redis set key holding revoked sessionIds. Populated by an auth-events
 *  subscriber if/when `auth.session.revoked` is published — same shape as
 *  the data engine's denylist (see gearsh-data-engine/src/common/guards/
 *  admin.guard.ts for the cross-engine reasoning). */
const SESSION_DENYLIST_PREFIX = 'admin:sid:denylist:';

/**
 * Gate for `/v1/admin/*` routes (conventions §10). Requires the ADMIN role on
 * the verified access token AND that the session id is not in a local Redis
 * denylist. Fails open on Redis blips (the JWT signature is the primary check).
 *
 * Audit-row writing is deferred to the admin module ticket (PAY-007), same
 * pattern as the data engine's AdminAuditMiddleware.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);

  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<Request>().user;
    if (!user) throw new AppException(ErrorCode.UNAUTHENTICATED);
    if (!user.roles.includes('ADMIN')) {
      throw new AppException(ErrorCode.ADMIN_REQUIRED);
    }
    if (user.sid) {
      try {
        const revoked = await this.redis.get(`${SESSION_DENYLIST_PREFIX}${user.sid}`);
        if (revoked) {
          throw new AppException(ErrorCode.SESSION_REVOKED, {
            detail: 'Admin session has been revoked.',
          });
        }
      } catch (err) {
        if (err instanceof AppException) throw err;
        this.logger.warn(`admin sid denylist lookup failed: ${(err as Error).message}`);
      }
    }
    return true;
  }
}
