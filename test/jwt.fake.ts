import { SignJWT, exportSPKI, exportPKCS8, generateKeyPair, importPKCS8 } from 'jose';

const ISSUER = 'gearsh-auth';
const AUDIENCE = 'gearsh-platform';

export interface FakeKeyMaterial {
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Generates an RS256 key pair (the Payments Engine only ever sees the public key). */
export async function generateKeyMaterial(): Promise<FakeKeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  return {
    publicKeyPem: await exportSPKI(publicKey),
    privateKeyPem: await exportPKCS8(privateKey),
  };
}

/** Signs a platform access token with the same claim shape Auth would issue. */
export async function signAccessToken(
  privateKeyPem: string,
  claims: { sub: string; roles: string[]; sid?: string },
): Promise<string> {
  const key = await importPKCS8(privateKeyPem, 'RS256');
  return new SignJWT({ roles: claims.roles, sid: claims.sid ?? 'sid-test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'auth-key-1' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setJti('jti-test')
    .setExpirationTime('15m')
    .sign(key);
}

/** Signs an internal service-to-service token (aud = internal). */
export async function signInternalToken(privateKeyPem: string, source: string): Promise<string> {
  const key = await importPKCS8(privateKeyPem, 'RS256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(`gearsh-${source}`)
    .setAudience('gearsh-platform-internal')
    .setIssuedAt()
    .setJti('internal-jti-test')
    .setExpirationTime('5m')
    .sign(key);
}
