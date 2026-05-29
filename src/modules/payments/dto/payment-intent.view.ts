import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency, IntentState } from '@prisma/client';

export class PaymentIntentView {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({ enum: IntentState })
  state!: IntentState;

  @ApiProperty({ enum: Currency })
  currency!: Currency;

  @ApiProperty({ enum: Currency })
  clientCurrency!: Currency;

  @ApiProperty({ minimum: 0 })
  subtotalCents!: number;

  @ApiProperty({ minimum: 0 })
  serviceFeeCents!: number;

  @ApiProperty({ minimum: 0 })
  totalCents!: number;

  @ApiPropertyOptional({ minimum: 0, description: 'FX-quoted ZAR amount at intent creation.' })
  quotedZarAmountCents!: number | null;

  @ApiPropertyOptional({ minimum: 0, description: 'Locked ZAR amount (set on POST /lock).' })
  zarAmountCentsLocked!: number | null;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Locked ZAR-denominated platform fee (set on POST /lock).',
  })
  zarServiceFeeCentsLocked!: number | null;

  @ApiPropertyOptional({ description: 'Locked rate as a decimal string.' })
  zarRateLocked!: string | null;

  @ApiPropertyOptional({ format: 'date-time' })
  zarLockedAt!: string | null;

  @ApiPropertyOptional({ format: 'date-time' })
  lockExpiresAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class LockPaymentIntentResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: IntentState })
  state!: IntentState;

  @ApiProperty({ description: 'PayFast hosted-checkout URL to redirect to.' })
  payfastRedirectUrl!: string;

  @ApiProperty({ description: 'Signed PayFast form parameters.', type: Object })
  formParams!: Record<string, string>;

  @ApiProperty({ description: 'Merchant payment reference echoed by PayFast.' })
  mPaymentId!: string;

  @ApiProperty({ format: 'date-time' })
  lockExpiresAt!: string;
}
