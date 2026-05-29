import { Inject, Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, type StrategyOptions } from 'passport-jwt';
import { APP_CONFIG } from '../../config/app-config.token';
import type { AppConfig } from '../../config/configuration';
import type { AuthUser, Role } from '../auth-user';

interface RawClaims {
  sub: string;
  roles: Role[];
  sid: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

/**
 * VERIFIES the platform access token (RS256) issued by the Auth Engine. The
 * Payments Engine never issues tokens; it holds only the Auth Engine's public
 * key (config.jwt.publicKey). Signature, issuer, audience and expiry are
 * checked by passport-jwt; we map the claims to AuthUser. Session-revocation
 * (`sid`) is Auth's concern and not re-checked here (conventions §9).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const options: StrategyOptions = {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.jwt.publicKey,
      algorithms: ['RS256'],
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
      ignoreExpiration: false,
    };
    super(options);
  }

  validate(payload: RawClaims): AuthUser {
    return {
      sub: payload.sub,
      roles: payload.roles ?? [],
      sid: payload.sid,
      iss: payload.iss,
      aud: payload.aud,
      iat: payload.iat,
      exp: payload.exp,
      jti: payload.jti,
    };
  }
}
