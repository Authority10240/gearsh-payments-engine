import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { AUDIT_ACTION_KEY } from './audit-action.decorator';

/**
 * Reads the handler's `@AuditAction('admin.payments.holds.release')` metadata
 * (set via `audit-action.decorator.ts`) and stamps it onto `req.auditAction`
 * so AdminAuditMiddleware can persist it on `res.on('finish')` without doing
 * its own Reflector walk (middlewares don't have ergonomic handler access).
 *
 * Wired globally via APP_INTERCEPTOR. The interceptor is a no-op on routes
 * without the decorator — the middleware falls back to the "<METHOD>
 * <route-template>" form.
 */
@Injectable()
export class AuditActionInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const action = this.reflector.getAllAndOverride<string | undefined>(AUDIT_ACTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (action) {
      const req = context.switchToHttp().getRequest<Request & { auditAction?: string }>();
      req.auditAction = action;
    }
    return next.handle();
  }
}
