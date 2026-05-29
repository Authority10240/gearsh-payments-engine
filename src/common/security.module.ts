import { Global, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AdminGuard } from './guards/admin.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { InternalServiceGuard } from './guards/internal-service.guard';

/**
 * Registers the JWT passport strategy (verify-only) and the reusable guards.
 * JwtAuthGuard + RolesGuard + InternalServiceGuard are wired globally via
 * APP_GUARD in app.module; AdminGuard is applied per-controller on
 * /v1/admin/* routes (PAY-007).
 */
@Global()
@Module({
  imports: [PassportModule],
  providers: [JwtStrategy, JwtAuthGuard, RolesGuard, AdminGuard, InternalServiceGuard],
  exports: [JwtAuthGuard, RolesGuard, AdminGuard, InternalServiceGuard, PassportModule],
})
export class SecurityModule {}
