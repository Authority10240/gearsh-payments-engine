import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EscrowState } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/** Body for POST /v1/escrow/holds/:id/refund — full refund. */
export class RefundHoldDto {
  @ApiPropertyOptional({
    enum: ['CLIENT', 'ARTIST'],
    description: 'Who is at fault for the refund (controls fee handling per business-rules §8.5).',
  })
  @IsOptional()
  @IsEnum(['CLIENT', 'ARTIST'])
  faultParty?: 'CLIENT' | 'ARTIST';

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Body for POST /v1/escrow/holds/:id/partial-refund. */
export class PartialRefundHoldDto {
  @ApiProperty({ minimum: 1, description: 'Refund amount in minor units (must be > 0).' })
  @IsInt()
  @Min(1)
  amountCents!: number;

  @ApiPropertyOptional({ enum: ['CLIENT', 'ARTIST'] })
  @IsOptional()
  @IsEnum(['CLIENT', 'ARTIST'])
  faultParty?: 'CLIENT' | 'ARTIST';

  @ApiProperty({ maxLength: 500 })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

/** Body for POST /v1/escrow/holds/:id/freeze. */
export class FreezeHoldDto {
  @ApiProperty({ maxLength: 500 })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

/** Body for /resolve-release and /resolve-refund. */
export class ResolveHoldDto {
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  resolutionNotes?: string;
}

/** Body for /resolve-split. The two amounts MUST sum to the hold's currently-
 *  held amount (amountCents - partiallyRefundedAmountCents). */
export class ResolveSplitHoldDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  artistCents!: number;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  clientCents!: number;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  resolutionNotes?: string;
}

/** Body for POST /v1/escrow/holds/:id/release — optional reason. */
export class ReleaseHoldDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Query for GET /v1/escrow/holds. */
export class ListHoldsQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  artistId?: string;

  @ApiPropertyOptional({ enum: EscrowState })
  @IsOptional()
  @IsEnum(EscrowState)
  state?: EscrowState;

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
