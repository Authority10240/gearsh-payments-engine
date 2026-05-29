import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArtistPayoutMethod, BankAccountType } from '@prisma/client';

/**
 * Wire view of an artist's payout method. The account number field is either
 * masked (`accountNumberMasked`, default) or plaintext (`accountNumber`, only
 * populated when AdminGuard + ?unmask=true). The two fields never appear
 * together — the controller decides which to set, the response only ever
 * carries one.
 */
export class PayoutMethodView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) artistUserId!: string;
  @ApiProperty() bankName!: string;
  @ApiProperty() accountHolderName!: string;
  @ApiProperty({ description: 'e.g. "••••••7890" — last 4 of the account number.' })
  accountNumberMasked!: string;
  @ApiPropertyOptional({
    description: 'Plaintext account number — present only on admin ?unmask=true.',
  })
  accountNumber?: string;
  @ApiProperty() branchCode!: string;
  @ApiProperty({ enum: BankAccountType }) accountType!: BankAccountType;
  @ApiProperty() isVerified!: boolean;
  @ApiPropertyOptional({ format: 'date-time' }) verifiedAt!: string | null;
  @ApiPropertyOptional({ format: 'uuid' }) verifiedBy!: string | null;
  @ApiPropertyOptional({ format: 'date-time' }) lastUsedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class PayoutMethodPageInfoView {
  @ApiPropertyOptional() nextCursor!: string | null;
  @ApiProperty() hasNextPage!: boolean;
}

export class PayoutMethodListResponse {
  @ApiProperty({ type: [PayoutMethodView] }) data!: PayoutMethodView[];
  @ApiProperty({ type: PayoutMethodPageInfoView }) pageInfo!: PayoutMethodPageInfoView;
}

/** Build a wire view from a row + an already-prepared (masked-or-plain) digits
 *  string. The caller decides which of accountNumberMasked / accountNumber to
 *  populate. */
export function toPayoutMethodView(
  row: ArtistPayoutMethod,
  digits: { masked: string; plaintext?: string },
): PayoutMethodView {
  return {
    id: row.id,
    artistUserId: row.artistUserId,
    bankName: row.bankName,
    accountHolderName: row.accountHolderName,
    accountNumberMasked: digits.masked,
    accountNumber: digits.plaintext,
    branchCode: row.branchCode,
    accountType: row.accountType,
    isVerified: row.isVerified,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    verifiedBy: row.verifiedBy,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
