import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { IS_INTERNAL_SERVICE_KEY } from '../decorators/internal-service.decorator';
import { AppException } from '../problem/app-exception';
import { ErrorCode } from '../problem/error-codes';

/**
 * Global authentication guard. Verifies the access token via the 'jwt'
 * strategy unless the handler is marked @Public() or @InternalService().
 * Token errors surface as RFC 7807 problems (TOKEN_EXPIRED vs UNAUTHENTICATED).
 *
 * @InternalService() routes are gated by InternalServiceGuard instead — they
 * accept X-Internal-Service-Token and MUST NOT be reached with a user JWT.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const isInternal = this.reflector.getAllAndOverride<boolean>(IS_INTERNAL_SERVICE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isInternal) return true;

    return super.canActivate(context);
  }

  handleRequest<TUser>(err: unknown, user: TUser, info: unknown): TUser {
    if (err || !user) {
      const name = (info as { name?: string } | undefined)?.name;
      if (name === 'TokenExpiredError') {
        throw new AppException(ErrorCode.TOKEN_EXPIRED);
      }
      throw new AppException(ErrorCode.UNAUTHENTICATED, {
        detail: (info as { message?: string } | undefined)?.message,
      });
    }
    return user;
  }
}
