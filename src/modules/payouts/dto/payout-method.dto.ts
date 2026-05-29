import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BankAccountType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Query-string boolean coercion: "true" / "1" → true, "false" / "0" → false,
 *  anything else → undefined so @IsOptional still accepts the absent value. */
function queryBoolean({ value }: { value: unknown }): boolean | undefined {
  if (value === true || value === false) return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

/**
 * Body for PUT /v1/payouts/method (artist self-upsert). Sets is_verified=false
 * on every write (business-rules §8.2 — re-verification required after any
 * change). The validators are deliberately lenient on accountNumber length
 * (5–34) to accommodate the spread of SA bank standards (CHEQUE/SAVINGS
 * typically 9–11; TRANSMISSION can be longer; IBAN-style up to 34).
 */
export class UpsertPayoutMethodDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  bankName!: string;

  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  accountHolderName!: string;

  /** Lenient: 5–34 alphanumeric characters. SA cheque/savings are typically 9–11
   *  but TRANSMISSION and corporate accounts can be longer; IBAN spec caps at 34. */
  @ApiProperty({
    minLength: 5,
    maxLength: 34,
    description: 'Bank account number (5–34 alphanumeric chars).',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9]{5,34}$/, {
    message: 'accountNumber must be 5–34 alphanumeric characters.',
  })
  accountNumber!: string;

  @ApiProperty({
    pattern: '^\\d{6}$',
    description: 'Six-digit South African branch code.',
  })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'branchCode must be 6 digits.' })
  branchCode!: string;

  @ApiProperty({ enum: BankAccountType })
  @IsEnum(BankAccountType)
  accountType!: BankAccountType;
}

/** Query for GET /v1/admin/payouts/methods. */
export class ListPayoutMethodsQueryDto {
  @ApiPropertyOptional({ description: 'Filter by verification status.' })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  isVerified?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from a prior page.' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

/** Query for GET /v1/admin/payouts/methods/:artistUserId. */
export class GetPayoutMethodQueryDto {
  @ApiPropertyOptional({
    description:
      'Set true to receive the plaintext account number (admin-only; audited). ' +
      'Default is masked.',
  })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  unmask?: boolean;
}

/** Body for POST /v1/admin/payouts/methods/:artistUserId/reject. */
export class RejectPayoutMethodDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
