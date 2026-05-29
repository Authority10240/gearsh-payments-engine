import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency, Payout, PayoutState } from '@prisma/client';

/** Wire view of a Payout row. BigInts → number, dates → ISO 8601. */
export class PayoutView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) artistId!: string;
  @ApiProperty({ format: 'uuid' }) holdId!: string;
  @ApiProperty({ minimum: 0 }) amountCents!: number;
  @ApiProperty({ enum: Currency }) currency!: Currency;
  @ApiProperty({ enum: PayoutState }) state!: PayoutState;
  @ApiProperty({ format: 'date-time' }) dispatchAfter!: string;
  @ApiPropertyOptional() gatewayPayoutId!: string | null;
  @ApiProperty({ minimum: 0 }) attempts!: number;
  @ApiPropertyOptional({ format: 'date-time' }) attemptedAt!: string | null;
  @ApiPropertyOptional({ format: 'date-time' }) failedAt!: string | null;
  @ApiPropertyOptional() failureReason!: string | null;
  @ApiPropertyOptional({ format: 'date-time' }) completedAt!: string | null;
  @ApiPropertyOptional({ format: 'date-time' }) cancelledAt!: string | null;
  @ApiPropertyOptional() cancellationReason!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class PayoutPageInfoView {
  @ApiPropertyOptional() nextCursor!: string | null;
  @ApiProperty() hasNextPage!: boolean;
}

export class PayoutListResponse {
  @ApiProperty({ type: [PayoutView] }) data!: PayoutView[];
  @ApiProperty({ type: PayoutPageInfoView }) pageInfo!: PayoutPageInfoView;
}

export function toPayoutView(p: Payout): PayoutView {
  return {
    id: p.id,
    artistId: p.artistId,
    holdId: p.holdId,
    amountCents: Number(p.amountCents),
    currency: p.currency,
    state: p.state,
    dispatchAfter: p.dispatchAfter.toISOString(),
    gatewayPayoutId: p.gatewayPayoutId,
    attempts: p.attempts,
    attemptedAt: p.attemptedAt ? p.attemptedAt.toISOString() : null,
    failedAt: p.failedAt ? p.failedAt.toISOString() : null,
    failureReason: p.failureReason,
    completedAt: p.completedAt ? p.completedAt.toISOString() : null,
    cancelledAt: p.cancelledAt ? p.cancelledAt.toISOString() : null,
    cancellationReason: p.cancellationReason,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
