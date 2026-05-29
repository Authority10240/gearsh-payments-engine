import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jwtVerify, importSPKI } from 'jose';
import type { Request } from 'express';
import { APP_CONFIG } from '../../config/app-config.token';
import type { AppConfig } from '../../config/configuration';
import { IS_INTERNAL_SERVICE_KEY } from '../decorators/internal-service.decorator';
import { AppException } from '../problem/app-exception';
import { ErrorCode } from '../problem/error-codes';

const HEADER = 'x-internal-service-token';

/**
 * Gate for routes marked @InternalService(). Accepts an internal token in two
 * forms (conventions §9 "Internal service-to-service calls"):
 *
 *   1. A signed RS256 JWT with `aud == INTERNAL_JWT_AUDIENCE` and `iss` starting
 *      with `gearsh-`. Verified against the same Auth public key used for user
 *      tokens (the Auth Engine issues both).
 *   2. A plain shared secret matching `INTERNAL_SERVICE_TOKEN` (optional;
 *      configured only for local dev / before Auth starts issuing internal
 *      JWTs to the data engine).
 *
 * The guard returns 401 UNAUTHENTICATED on missing/invalid tokens.
 */
@Injectable()
export class InternalServiceGuard implements CanActivate {
  private readonly logger = new Logger(InternalServiceGuard.name);
  private publicKeyPromise?: Promise<Awaited<ReturnType<typeof importSPKI>>>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isInternal = this.reflector.getAllAndOverride<boolean>(IS_INTERNAL_SERVICE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isInternal) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const token = (req.header(HEADER) || '').trim();
    if (!token) {
      throw new AppException(ErrorCode.UNAUTHENTICATED, {
        detail: 'Missing X-Internal-Service-Token header.',
      });
    }

    const shared = this.config.services.internalServiceToken;
    if (shared && token === shared) return true;

    try {
      const key = await this.getPublicKey();
      await jwtVerify(token, key, {
        algorithms: ['RS256'],
        audience: this.config.jwt.internalAudience,
      });
      return true;
    } catch (err) {
      this.logger.debug(`Internal token rejected: ${(err as Error).message}`);
      throw new AppException(ErrorCode.UNAUTHENTICATED, {
        detail: 'Invalid X-Internal-Service-Token.',
      });
    }
  }

  private getPublicKey(): Promise<Awaited<ReturnType<typeof importSPKI>>> {
    if (!this.publicKeyPromise) {
      this.publicKeyPromise = importSPKI(this.config.jwt.publicKey, 'RS256');
    }
    return this.publicKeyPromise;
  }
}
