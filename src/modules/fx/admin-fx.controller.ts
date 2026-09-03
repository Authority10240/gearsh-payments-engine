import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsNumberString } from 'class-validator';
import { Currency } from '@prisma/client';
import { AdminGuard } from '../../common/guards/admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/auth-user';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';
import { FxService } from './fx.service';

class PutFxOverrideDto {
  @ApiProperty({ example: '18.50000000', description: 'Decimal rate as a string.' })
  @IsNumberString()
  rate!: string;
}

function parseCurrency(raw: string): Currency {
  const up = raw.toUpperCase();
  if (!(up in Currency)) {
    throw new AppException(ErrorCode.VALIDATION_FAILED, {
      detail: `Unsupported currency '${raw}'.`,
    });
  }
  return up as Currency;
}

/**
 * PAY-008 — admin FX rate overrides (§9.12, /v1/admin/fx/overrides).
 * A pinned pair beats provider/seed rows in every conversion until deleted;
 * the daily provider refresh keeps writing exchange_rates but cannot unpin.
 */
@ApiTags('admin-fx')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('v1/admin/fx/overrides')
export class AdminFxController {
  constructor(private readonly fx: FxService) {}

  @Get()
  @ApiOperation({ operationId: 'adminListFxOverrides', summary: 'List pinned FX rates' })
  list() {
    return this.fx.listOverrides();
  }

  @Put(':from/:to')
  @ApiOperation({ operationId: 'adminPutFxOverride', summary: 'Pin a rate for a pair' })
  put(
    @Param('from') from: string,
    @Param('to') to: string,
    @Body() dto: PutFxOverrideDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.fx.putOverride(parseCurrency(from), parseCurrency(to), dto.rate, admin.sub);
  }

  @Delete(':from/:to')
  @HttpCode(204)
  @ApiOperation({ operationId: 'adminDeleteFxOverride', summary: 'Unpin a pair' })
  async remove(@Param('from') from: string, @Param('to') to: string): Promise<void> {
    await this.fx.deleteOverride(parseCurrency(from), parseCurrency(to));
  }
}
