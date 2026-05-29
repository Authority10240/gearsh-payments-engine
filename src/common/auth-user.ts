/**
 * Platform role union, mirrored from contracts/conventions.md §9 (Auth's JWT
 * `roles` claim). The Payments Engine doesn't own users — so unlike the data
 * engine it pulls Role from no Prisma enum and instead defines it here. The
 * shape MUST match the auth token contract exactly.
 */
export type Role = 'CLIENT' | 'ARTIST' | 'FAN' | 'ADMIN';

export const ROLES: readonly Role[] = ['CLIENT', 'ARTIST', 'FAN', 'ADMIN'] as const;

/** Decoded platform access-token claims attached to the request. */
export interface AuthUser {
  /** User UUID. */
  sub: string;
  roles: Role[];
  /** Session id (for revocation). */
  sid: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}
