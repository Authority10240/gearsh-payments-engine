import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RefundState } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Body for POST /v1/refunds. PAY-004 — admin-driven lever and auto-refund
 * fallback when subscribers escalate (PAY-006 dispute resolution + booking
 * cancellation handlers call RefundsService.issueRefund DIRECTLY via DI; they
 * do NOT go through HTTP).
 *
 * Targeting:
 *   - At least one of holdId or transactionId must be provided. holdId is the
 *     idiomatic admin path; transactionId is supported because the OpenAPI
 *     spec (gearsh-payments-engine.md §API surface) lists it.
 *   - `full=true` ignores refundCents and refunds the remaining balance
 *     (amountCents - partiallyRefundedAmountCents); otherwise refundCents is
 *     required.
 */
export class CreateRefundDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Target escrow hold id.' })
  @IsOptional()
  @IsUUID()
  holdId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'CHARGE transaction id (alternative to holdId).',
  })
  @IsOptional()
  @IsUUID()
  transactionId?: string;

  @ApiPropertyOptional({
    minimum: 1,
    description: 'Refund amount in minor units. Required unless `full=true`.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  refundCents?: number;

  @ApiPropertyOptional({
    description: 'When true, refunds the entire remaining held balance.',
  })
  @IsOptional()
  @IsBoolean()
  full?: boolean;

  @ApiProperty({ maxLength: 500 })
  @IsString()
  @MaxLength(500)
  reason!: string;

  @ApiProperty({
    enum: ['CLIENT', 'ARTIST', 'NONE'],
    description:
      'Fault attribution drives platform-fee handling (business-rules §8.5). ' +
      'CLIENT-initiated keeps fee in PLATFORM_REVENUE; ARTIST-fault on a full ' +
      'refund reverses the fee; NONE is admin-discretion (treated as CLIENT for fee).',
  })
  @IsEnum(['CLIENT', 'ARTIST', 'NONE'])
  faultParty!: 'CLIENT' | 'ARTIST' | 'NONE';
}

/** Query for GET /v1/refunds. */
export class ListRefundsQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  holdId?: string;

  @ApiPropertyOptional({ enum: RefundState })
  @IsOptional()
  @IsEnum(RefundState)
  state?: RefundState;

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
