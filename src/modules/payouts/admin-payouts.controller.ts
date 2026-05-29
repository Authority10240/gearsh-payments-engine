import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/auth-user';
import { AdminGuard } from '../../common/guards/admin.guard';
import { IdempotencyService } from '../../common/idempotency.service';
import { ListPayoutsQueryDto } from './dto/payout.dto';
import { PayoutListResponse, PayoutView, toPayoutView } from './dto/payout.view';
import { PayoutsService } from './payouts.service';

/** Body for POST /v1/admin/payouts/:id/cancel. Optional reason override (the
 *  default cancellation_reason is 'ADMIN'). */
export class CancelPayoutDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * Admin REST surface for payouts (PAY-005, gearsh-payments-engine.md §API
 * surface — admin payouts routes).
 *
 *   - GET    /v1/admin/payouts                    — paginated list (filters).
 *   - GET    /v1/admin/payouts/:id                — payout detail.
 *   - POST   /v1/admin/payouts/:id/retry          — manual retry (FAILED → QUEUED).
 *   - POST   /v1/admin/payouts/:id/cancel         — cancel a QUEUED payout.
 *
 * The mutation routes accept Idempotency-Key per conventions §11. Replays
 * with the SAME body return the cached response with `Idempotency-Replay`.
 */
@ApiTags('payouts')
@ApiBearerAuth()
@Controller('v1/admin/payouts')
@UseGuards(AdminGuard)
export class AdminPayoutsController {
  constructor(
    private readonly payouts: PayoutsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @ApiOperation({ operationId: 'listPayoutsAdmin', summary: 'List payouts (admin).' })
  @ApiOkResponse({ type: PayoutListResponse })
  async list(@Query() query: ListPayoutsQueryDto): Promise<PayoutListResponse> {
    const page = await this.payouts.list({
      state: query.state,
      artistUserId: query.artistUserId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit,
      cursor: query.cursor,
    });
    return {
      data: page.data.map(toPayoutView),
      pageInfo: {
        hasNextPage: page.pageInfo.hasNextPage,
        nextCursor: page.pageInfo.nextCursor,
      },
    };
  }

  @Get(':id')
  @ApiOperation({ operationId: 'getPayoutAdmin', summary: 'Payout detail (admin).' })
  @ApiOkResponse({ type: PayoutView })
  async getOne(@Param('id', new ParseUUIDPipe({ version: '7' })) id: string): Promise<PayoutView> {
    return toPayoutView(await this.payouts.getById(id));
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'retryPayoutAdmin',
    summary: 'Manually requeue a FAILED payout (admin lever).',
  })
  @ApiOkResponse({ type: PayoutView })
  async retry(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PayoutView> {
    const result = await this.idempotency.run(
      {
        endpoint: `POST /v1/admin/payouts/${id}/retry`,
        userId: user.sub,
        idempotencyKey,
        requestBody: null,
      },
      async () => ({
        status: 200,
        body: toPayoutView(await this.payouts.retry(id)),
      }),
    );
    if (result.replayed) res.setHeader('Idempotency-Replay', 'true');
    return result.body;
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'cancelPayoutAdmin',
    summary: 'Cancel a QUEUED payout (admin lever; sets state=CANCELLED).',
  })
  @ApiOkResponse({ type: PayoutView })
  async cancel(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CancelPayoutDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PayoutView> {
    const result = await this.idempotency.run(
      {
        endpoint: `POST /v1/admin/payouts/${id}/cancel`,
        userId: user.sub,
        idempotencyKey,
        requestBody: dto,
      },
      async () => ({
        status: 200,
        body: toPayoutView(await this.payouts.cancel(id, { reason: dto.reason })),
      }),
    );
    if (result.replayed) res.setHeader('Idempotency-Replay', 'true');
    return result.body;
  }
}
