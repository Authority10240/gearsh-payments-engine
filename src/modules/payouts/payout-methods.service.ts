import { Injectable, Logger } from '@nestjs/common';
import { ArtistPayoutMethod, BankAccountType, Prisma } from '@prisma/client';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';
import { buildPage, clampLimit, decodeCursor, type Page } from '../../common/pagination';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * Inputs for upserting an artist payout method (artist self-write, admin
 * verify is a separate endpoint).
 */
export interface UpsertPayoutMethodInput {
  artistUserId: string;
  bankName: string;
  accountHolderName: string;
  accountNumber: string;
  branchCode: string;
  accountType: BankAccountType;
}

export interface ListPayoutMethodsQuery {
  isVerified?: boolean;
  limit?: number;
  cursor?: string;
}

/**
 * artist_payout_methods CRUD (PAY-005, business-rules §8.2).
 *
 *   - upsert(): used by the artist-self PUT route. Always sets
 *     is_verified=false because a change to bank details means re-verification.
 *   - getForArtist(): the artist-self GET; returns masked digits.
 *   - listForAdmin() / getForAdmin(): admin reads, masked by default. The
 *     `?unmask=true` admin path decrypts via EncryptionService.
 *   - verify() / reject(): admin-only state flips. verified_by is set to the
 *     admin actor id.
 *
 * The PayoutDispatcherJob ALSO reads from this service (getRawForDispatch)
 * because it needs the ciphertext bytea to hand to EncryptionService.decrypt().
 * That path is internal — not exposed via HTTP.
 */
@Injectable()
export class PayoutMethodsService {
  private readonly logger = new Logger(PayoutMethodsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /** Upsert the artist's own method. Always flips is_verified=false. */
  async upsert(input: UpsertPayoutMethodInput): Promise<ArtistPayoutMethod> {
    const encrypted = await this.encryption.encrypt(input.accountNumber);
    // findUnique → update / create (vs Prisma upsert) because we want to
    // null verified_at + verified_by + last_used_at on a real update; an upsert
    // that touched only `update` would leak the stale `verified_at` until the
    // first re-verify. Two-step here keeps the post-condition explicit.
    const existing = await this.prisma.artistPayoutMethod.findUnique({
      where: { artistUserId: input.artistUserId },
    });
    if (existing) {
      return this.prisma.artistPayoutMethod.update({
        where: { artistUserId: input.artistUserId },
        data: {
          bankName: input.bankName,
          accountHolderName: input.accountHolderName,
          accountNumberEncrypted: encrypted,
          branchCode: input.branchCode,
          accountType: input.accountType,
          isVerified: false,
          verifiedAt: null,
          verifiedBy: null,
          // lastUsedAt is preserved as audit; only nulled on creation.
        },
      });
    }
    return this.prisma.artistPayoutMethod.create({
      data: {
        artistUserId: input.artistUserId,
        bankName: input.bankName,
        accountHolderName: input.accountHolderName,
        accountNumberEncrypted: encrypted,
        branchCode: input.branchCode,
        accountType: input.accountType,
        isVerified: false,
      },
    });
  }

  /** Artist self-read. Throws NOT_FOUND when no row exists. */
  async getForArtist(artistUserId: string): Promise<ArtistPayoutMethod> {
    const row = await this.prisma.artistPayoutMethod.findUnique({
      where: { artistUserId },
    });
    if (!row) throw new AppException(ErrorCode.NOT_FOUND);
    return row;
  }

  /** Admin paginated list (filter by isVerified). */
  async listForAdmin(query: ListPayoutMethodsQuery): Promise<Page<ArtistPayoutMethod>> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const where: Prisma.ArtistPayoutMethodWhereInput = {};
    if (query.isVerified !== undefined) where.isVerified = query.isVerified;
    if (cursor) {
      where.OR = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
    }
    const rows = await this.prisma.artistPayoutMethod.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return buildPage(rows, limit);
  }

  /** Admin single read by artist user id. */
  async getForAdmin(artistUserId: string): Promise<ArtistPayoutMethod> {
    const row = await this.prisma.artistPayoutMethod.findUnique({ where: { artistUserId } });
    if (!row) throw new AppException(ErrorCode.NOT_FOUND);
    return row;
  }

  /** Decrypt the ciphertext bytea → plaintext digits. Authorised callers only
   *  (admin ?unmask=true; dispatcher about to call PayFast Adhoc). */
  async decryptAccountNumber(row: ArtistPayoutMethod): Promise<string> {
    return this.encryption.decrypt(row.accountNumberEncrypted);
  }

  /** Convenience for read surfaces: return the masked digits without ever
   *  exposing plaintext to the controller. */
  async maskedAccountNumberFor(row: ArtistPayoutMethod): Promise<string> {
    const plaintext = await this.encryption.decrypt(row.accountNumberEncrypted);
    return this.encryption.mask(plaintext);
  }

  /** Admin verify. */
  async verify(artistUserId: string, adminUserId: string): Promise<ArtistPayoutMethod> {
    const row = await this.prisma.artistPayoutMethod.findUnique({ where: { artistUserId } });
    if (!row) throw new AppException(ErrorCode.NOT_FOUND);
    if (row.isVerified) return row; // idempotent — already verified
    return this.prisma.artistPayoutMethod.update({
      where: { artistUserId },
      data: {
        isVerified: true,
        verifiedAt: new Date(),
        verifiedBy: adminUserId,
      },
    });
  }

  /** Admin reject — unset is_verified. Reason is logged (admin-audit middleware
   *  is a PAY-007 concern; for now it lives in the application log only). */
  async reject(
    artistUserId: string,
    adminUserId: string,
    reason?: string,
  ): Promise<ArtistPayoutMethod> {
    const row = await this.prisma.artistPayoutMethod.findUnique({ where: { artistUserId } });
    if (!row) throw new AppException(ErrorCode.NOT_FOUND);
    if (!row.isVerified) return row; // idempotent — already unverified
    this.logger.warn(
      `admin rejected payout method artistUserId=${artistUserId} admin=${adminUserId} reason=${reason ?? '<none>'}`,
    );
    return this.prisma.artistPayoutMethod.update({
      where: { artistUserId },
      data: {
        isVerified: false,
        verifiedAt: null,
        verifiedBy: null,
      },
    });
  }
}
