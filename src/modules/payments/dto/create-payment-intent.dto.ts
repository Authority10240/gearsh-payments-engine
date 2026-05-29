import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

/**
 * Body for POST /v1/payment-intents (internal service auth — called by Data
 * Engine on booking create). All monetary amounts are in the CLIENT's currency.
 *
 * `serviceFeeCents` is OPTIONAL: when omitted the engine derives it as
 * round(subtotal * SERVICE_FEE_PERCENT / 100). `totalCents` MUST equal
 * subtotal + serviceFee (validated server-side).
 */
export class CreatePaymentIntentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  bookingId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  clientId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  artistId!: string;

  @ApiProperty({ minimum: 0, description: 'Amount in minor units (cents).' })
  @IsInt()
  @Min(0)
  subtotalCents!: number;

  @ApiProperty({ enum: Currency, description: "Booking's currency." })
  @IsEnum(Currency)
  currency!: Currency;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  serviceFeeCents?: number;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  totalCents!: number;

  @ApiPropertyOptional({
    enum: Currency,
    description: "Client's preferred display currency. Defaults to `currency`.",
  })
  @IsOptional()
  @IsEnum(Currency)
  clientCurrency?: Currency;

  @ApiPropertyOptional({ description: 'Client-supplied idempotency key (UUID/ULID).' })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
