import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Refund, RefundState } from '@prisma/client';

/** Wire view of a Refund row. BigInts → number, dates → ISO 8601 (conventions §3). */
export class RefundView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) transactionId!: string;
  @ApiProperty({ minimum: 0 }) amountCents!: number;
  @ApiPropertyOptional() reason!: string | null;
  @ApiProperty({ format: 'uuid' }) initiatedBy!: string;
  @ApiProperty({ enum: RefundState }) state!: RefundState;
  @ApiPropertyOptional() gatewayRefundId!: string | null;
  @ApiPropertyOptional() failureReason!: string | null;
  @ApiPropertyOptional({ format: 'date-time' }) completedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class PageInfoView {
  @ApiPropertyOptional() nextCursor!: string | null;
  @ApiProperty() hasNextPage!: boolean;
}

export class RefundListResponse {
  @ApiProperty({ type: [RefundView] }) data!: RefundView[];
  @ApiProperty({ type: PageInfoView }) pageInfo!: PageInfoView;
}

/** Returned by GET /v1/escrow/holds/:id/refundability (canRefund helper). */
export class RefundEligibilityView {
  @ApiProperty({ format: 'uuid' }) holdId!: string;
  @ApiProperty() canRefund!: boolean;
  @ApiProperty({ minimum: 0, description: 'Maximum cents still refundable on this hold.' })
  maxRefundableCents!: number;
  @ApiPropertyOptional({
    description: 'When canRefund is false, the canonical reason (NOT_REFUNDABLE_TERMINAL, etc).',
  })
  reason!: string | null;
}

export function toRefundView(r: Refund): RefundView {
  return {
    id: r.id,
    transactionId: r.transactionId,
    amountCents: Number(r.amountCents),
    reason: r.reason,
    initiatedBy: r.initiatedBy,
    state: r.state,
    gatewayRefundId: r.gatewayRefundId,
    failureReason: r.failureReason,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
