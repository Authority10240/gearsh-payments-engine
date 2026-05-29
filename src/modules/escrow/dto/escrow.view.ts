import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency, EscrowHold, EscrowState } from '@prisma/client';

/** Wire-format view of an EscrowHold. BigInts → number, dates → ISO 8601. */
export class EscrowHoldView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) bookingId!: string;
  @ApiProperty({ format: 'uuid' }) paymentIntentId!: string;
  @ApiProperty({ format: 'uuid' }) clientId!: string;
  @ApiProperty({ format: 'uuid' }) artistId!: string;
  @ApiProperty({ minimum: 0 }) amountCents!: number;
  @ApiProperty({ minimum: 0 }) platformFeeCents!: number;
  @ApiProperty({ minimum: 0 }) partiallyRefundedAmountCents!: number;
  @ApiProperty({ enum: Currency }) currency!: Currency;
  @ApiProperty({ enum: EscrowState }) state!: EscrowState;
  @ApiProperty({ format: 'date-time' }) heldAt!: string;
  @ApiPropertyOptional({ format: 'date-time' }) releasedAt!: string | null;
  @ApiPropertyOptional({ format: 'date-time' }) refundedAt!: string | null;
  @ApiPropertyOptional({ format: 'date-time' }) disputedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class PageInfoView {
  @ApiPropertyOptional({ description: 'Cursor for the next page (null when last).' })
  nextCursor!: string | null;
  @ApiProperty() hasNextPage!: boolean;
}

export class EscrowHoldListResponse {
  @ApiProperty({ type: [EscrowHoldView] }) data!: EscrowHoldView[];
  @ApiProperty({ type: PageInfoView }) pageInfo!: PageInfoView;
}

export function toEscrowHoldView(hold: EscrowHold): EscrowHoldView {
  return {
    id: hold.id,
    bookingId: hold.bookingId,
    paymentIntentId: hold.paymentIntentId,
    clientId: hold.clientId,
    artistId: hold.artistId,
    amountCents: Number(hold.amountCents),
    platformFeeCents: Number(hold.platformFeeCents),
    partiallyRefundedAmountCents: Number(hold.partiallyRefundedAmountCents),
    currency: hold.currency,
    state: hold.state,
    heldAt: hold.heldAt.toISOString(),
    releasedAt: hold.releasedAt ? hold.releasedAt.toISOString() : null,
    refundedAt: hold.refundedAt ? hold.refundedAt.toISOString() : null,
    disputedAt: hold.disputedAt ? hold.disputedAt.toISOString() : null,
    createdAt: hold.createdAt.toISOString(),
    updatedAt: hold.updatedAt.toISOString(),
  };
}
