import { ApiProperty } from '@nestjs/swagger';

export class RateView {
  @ApiProperty({ enum: ['ZAR', 'USD', 'GBP', 'NGN', 'KES', 'GHS', 'AUD', 'CAD'] })
  toCurrency!: string;

  @ApiProperty({ example: '0.054', description: 'Mid-market rate as a decimal string.' })
  rate!: string;

  @ApiProperty({ example: '2026-05-29T02:00:00.000Z' })
  asOf!: string;

  @ApiProperty({ enum: ['OPEN_EXCHANGE_RATES', 'STUB', 'MANUAL'] })
  source!: string;
}

export class RatesResponse {
  @ApiProperty({ enum: ['ZAR', 'USD', 'GBP', 'NGN', 'KES', 'GHS', 'AUD', 'CAD'] })
  base!: string;

  @ApiProperty({ type: () => [RateView] })
  rates!: RateView[];
}
