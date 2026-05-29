import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Role } from '../auth-user';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AppException } from '../problem/app-exception';
import { ErrorCode } from '../problem/error-codes';

/**
 * Enforces @Roles(...) on a route by intersecting required roles with the
 * caller's token roles. Runs after JwtAuthGuard so req.user is populated.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest<Request>().user;
    if (!user) throw new AppException(ErrorCode.UNAUTHENTICATED);

    const ok = required.some((r) => user.roles.includes(r));
    if (!ok) throw new AppException(ErrorCode.FORBIDDEN);
    return true;
  }
}
