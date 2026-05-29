import { ApiPropertyOptional } from '@nestjs/swagger';
import { PayoutState } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/** Query for GET /v1/admin/payouts. */
export class ListPayoutsQueryDto {
  @ApiPropertyOptional({ enum: PayoutState })
  @IsOptional()
  @IsEnum(PayoutState)
  state?: PayoutState;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  artistUserId?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  to?: string;

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
