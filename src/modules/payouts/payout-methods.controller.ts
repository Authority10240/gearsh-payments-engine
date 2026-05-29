import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthUser } from '../../common/auth-user';
import { IdempotencyService } from '../../common/idempotency.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UpsertPayoutMethodDto } from './dto/payout-method.dto';
import { PayoutMethodView, toPayoutMethodView } from './dto/payout-method.view';
import { PayoutMethodsService } from './payout-methods.service';

/**
 * Artist-self surface for the artist's own payout method (PAY-005).
 *
 *   - GET    /v1/payouts/method      — caller's method (masked).
 *   - PUT    /v1/payouts/method      — upsert, sets isVerified=false.
 *
 * @Roles('ARTIST') ensures only artists can read/write their own row; the
 * ownership scope is implicit — the artist's user-id is the row key
 * (artist_user_id UNIQUE) so they can only ever see their own.
 */
@ApiTags('payouts')
@ApiBearerAuth()
@Controller('v1/payouts/method')
@Roles('ARTIST')
@UseGuards(RolesGuard)
export class PayoutMethodsController {
  constructor(
    private readonly methods: PayoutMethodsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'getMyPayoutMethod',
    summary: "Get caller's payout method (masked).",
  })
  @ApiOkResponse({ type: PayoutMethodView })
  async getMine(@CurrentUser() user: AuthUser): Promise<PayoutMethodView> {
    const row = await this.methods.getForArtist(user.sub);
    const masked = await this.methods.maskedAccountNumberFor(row);
    return toPayoutMethodView(row, { masked });
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'upsertMyPayoutMethod',
    summary: 'Upsert the caller’s payout method. Sets isVerified=false.',
  })
  @ApiOkResponse({ type: PayoutMethodView })
  async upsertMine(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpsertPayoutMethodDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() _req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PayoutMethodView> {
    const result = await this.idempotency.run(
      {
        endpoint: 'PUT /v1/payouts/method',
        userId: user.sub,
        idempotencyKey,
        // The dto carries the digits — IdempotencyService hashes the body so
        // a same-key + different-account-number is correctly flagged as a
        // mismatch (Idempotency-Key has 24h TTL per conventions §11).
        requestBody: dto,
      },
      async () => {
        const row = await this.methods.upsert({
          artistUserId: user.sub,
          bankName: dto.bankName,
          accountHolderName: dto.accountHolderName,
          accountNumber: dto.accountNumber,
          branchCode: dto.branchCode,
          accountType: dto.accountType,
        });
        const masked = await this.methods.maskedAccountNumberFor(row);
        return { status: 200, body: toPayoutMethodView(row, { masked }) };
      },
    );
    if (result.replayed) res.setHeader('Idempotency-Replay', 'true');
    return result.body;
  }
}
