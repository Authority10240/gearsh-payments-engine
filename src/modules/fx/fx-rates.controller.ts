import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Currency } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';
import { RatesResponse } from './dto/rates.view';
import { FxService } from './fx.service';

const SUPPORTED: Currency[] = ['ZAR', 'USD', 'GBP', 'NGN', 'KES', 'GHS', 'AUD', 'CAD'];

@ApiTags('fx')
@Controller('v1/rates')
export class FxRatesController {
  constructor(private readonly fx: FxService) {}

  @Public()
  @Get()
  @ApiOperation({ operationId: 'getRates', summary: 'Current cached exchange rates' })
  @ApiQuery({ name: 'base', required: false, enum: SUPPORTED })
  async list(@Query('base') baseRaw?: string): Promise<RatesResponse> {
    const base = (baseRaw ?? 'ZAR').toUpperCase() as Currency;
    if (!SUPPORTED.includes(base)) {
      throw new AppException(ErrorCode.CURRENCY_UNSUPPORTED, {
        detail: `${base} is not a supported currency.`,
      });
    }
    const rates = await this.fx.listLatestRates(base);
    return {
      base,
      rates: rates.map((r) => ({
        toCurrency: r.toCurrency,
        rate: r.rate,
        asOf: r.asOf.toISOString(),
        source: r.source,
      })),
    };
  }
}
