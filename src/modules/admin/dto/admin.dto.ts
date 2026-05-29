import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IntentState, PayoutState, TransactionState } from '@prisma/client';
import {
  IsBooleanString,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Reusable cursor pagination fields shared across admin list endpoints. */
export class CursorPageQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque pagination cursor.' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class ListReconciliationRunsQuery extends CursorPageQuery {
  @ApiPropertyOptional({ description: 'ISO date or datetime (lower bound, inclusive).' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date or datetime (upper bound, inclusive).' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class TriggerReconciliationQuery {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD; defaults to yesterday (SAST).' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  asOfDate?: string;
}

export class ListAdminTransactionsQuery extends CursorPageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  intentId?: string;

  @ApiPropertyOptional({ enum: TransactionState })
  @IsOptional()
  @IsEnum(TransactionState)
  state?: TransactionState;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class ListLedgerEntriesQuery extends CursorPageQuery {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD; defaults to today (SAST).' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  date?: string;
}

export class ListAuditQuery extends CursorPageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({ description: 'Exact match on the audit `action` column.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  action?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    description: 'Set to "true" to include the redacted requestBody in the response.',
  })
  @IsOptional()
  @IsBooleanString()
  includeBody?: string;
}

// Re-exports kept here so the controller can ergonomically import "everything
// admin-DTO-shaped" from one place even though we don't currently filter on
// IntentState / PayoutState directly.
export { IntentState, PayoutState, TransactionState };
