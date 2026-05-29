import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { APP_CONFIG } from '../../config/app-config.token';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * Bank-account encryption helper (PAY-005, business-rules §8.2). Account
 * numbers MUST be encrypted at rest; we use Postgres `pgcrypto` symmetric
 * encryption (pgp_sym_encrypt / pgp_sym_decrypt) so the secret lives in
 * Secret Manager (PAYOUT_METHOD_ENCRYPTION_KEY) and never in app memory
 * longer than the round-trip — the plaintext is passed through Prisma's
 * parameterised raw SQL and discarded once the bytea is bound onto the row.
 *
 * Authorisation
 * -------------
 *   - encrypt(): callable from anywhere that has the artist's plaintext —
 *     i.e. the PUT /v1/payouts/method controller (artist-self upsert) and
 *     the dispatcher when it persists a new method-of-record migration. Not
 *     dangerous on its own (encrypt is one-way until paired with decrypt).
 *   - decrypt(): authorised callers ONLY:
 *       (a) the payout dispatcher cron, which needs plaintext to call
 *           PayFast Adhoc Payments;
 *       (b) the admin `?unmask=true` path on
 *           GET /v1/admin/payouts/methods/:artistUserId — gated by
 *           AdminGuard + an explicit query-flag so a routine list/view of
 *           verified methods cannot accidentally pull plaintext.
 *     Other call sites should use `mask()` instead.
 *   - mask(): pure, no DB — used by every read surface so masked digits
 *     are the default response shape.
 */
@Injectable()
export class EncryptionService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Encrypt a plaintext bank-account number using Postgres pgcrypto. Returns
   * the bytea ready to bind onto artist_payout_methods.account_number_encrypted.
   *
   * We round-trip through Postgres rather than implement AES-GCM in Node so
   * the encrypted column is portable across services that also use pgcrypto
   * (matches the deployment story the business rules locked in: "Postgres
   * pgcrypto with a Secret Manager key"). The key is bound as a parameter so
   * it never appears in logs / query plans.
   */
  async encrypt(plaintext: string): Promise<Buffer> {
    const key = this.config.payoutMethodEncryptionKey;
    const rows = await this.prisma.$queryRaw<{ ct: Buffer }[]>`
      SELECT pgp_sym_encrypt(${plaintext}::text, ${key}::text) AS ct
    `;
    return rows[0].ct;
  }

  /**
   * Decrypt a bytea bank-account number. Admin-authorised callers only — the
   * controller layer is responsible for AdminGuard + ?unmask=true gating; the
   * dispatcher calls this when it needs plaintext to hand off to PayFast.
   */
  async decrypt(ciphertext: Buffer): Promise<string> {
    const key = this.config.payoutMethodEncryptionKey;
    const rows = await this.prisma.$queryRaw<{ pt: string }[]>`
      SELECT pgp_sym_decrypt(${ciphertext}::bytea, ${key}::text) AS pt
    `;
    return rows[0].pt;
  }

  /**
   * Pure: redact all but the last 4 characters of an account number. Used by
   * the read surfaces (artist self-view + admin list/detail) so the default
   * response shape never carries plaintext.
   *
   * Examples:
   *   "1234567890"      → "••••••7890"
   *   "12345"           → "•7890"-style: 1 dot + last 4 ("•2345")
   *   "1234"            → "1234"   (length <= 4, nothing to mask)
   *   ""                → ""
   */
  mask(plaintext: string): string {
    if (!plaintext) return '';
    if (plaintext.length <= 4) return plaintext;
    const last4 = plaintext.slice(-4);
    const dots = '•'.repeat(plaintext.length - 4);
    return `${dots}${last4}`;
  }
}

/** Helper for code paths that need a Prisma.sql binding rather than a service
 *  call (e.g. an INSERT that wants to compute the encrypted bytea inline). */
export function pgpSymEncryptSql(plaintext: string, key: string): Prisma.Sql {
  return Prisma.sql`pgp_sym_encrypt(${plaintext}::text, ${key}::text)`;
}
