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
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import type { AuthUser } from '../../common/auth-user';
import { IdempotencyService } from '../../common/idempotency.service';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';
import { CreateRefundDto, ListRefundsQueryDto } from './dto/refunds.dto';
import {
  RefundEligibilityView,
  RefundListResponse,
  RefundView,
  toRefundView,
} from './dto/refund.view';
import { RefundsService } from './refunds.service';

/**
 * Admin REST surface for refunds (gearsh-payments-engine.md §API surface:
 * POST /v1/refunds, GET /v1/refunds, GET /v1/refunds/:id, plus the
 * eligibility-helper convenience route at GET /v1/refunds/eligibility/:holdId).
 *
 * AdminGuard enforces ADMIN role + session-id denylist. Subscribers (PAY-006)
 * call RefundsService.issueRefund() DIRECTLY via DI — this HTTP route is the
 * manual admin lever and the auto-refund fallback when subscribers escalate.
 */
@ApiTags('refunds')
@ApiBearerAuth()
@Controller('v1/refunds')
@UseGuards(AdminGuard)
export class RefundsController {
  constructor(
    private readonly refunds: RefundsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ operationId: 'getRefund', summary: 'Refund detail (admin).' })
  @ApiOkResponse({ type: RefundView })
  async getById(@Param('id', new ParseUUIDPipe({ version: '7' })) id: string): Promise<RefundView> {
    return toRefundView(await this.refunds.getById(id));
  }

  @Get()
  @ApiOperation({ operationId: 'listRefunds', summary: 'List refunds (admin).' })
  @ApiOkResponse({ type: RefundListResponse })
  async list(@Query() query: ListRefundsQueryDto): Promise<RefundListResponse> {
    const page = await this.refunds.list({
      holdId: query.holdId,
      state: query.state,
      limit: query.limit,
      cursor: query.cursor,
    });
    return {
      data: page.data.map(toRefundView),
      pageInfo: {
        hasNextPage: page.pageInfo.hasNextPage,
        nextCursor: page.pageInfo.nextCursor,
      },
    };
  }

  @Get('eligibility/:holdId')
  @ApiOperation({
    operationId: 'getRefundEligibility',
    summary: 'Refund eligibility + max-refundable-cents for an escrow hold (admin).',
  })
  @ApiOkResponse({ type: RefundEligibilityView })
  async eligibility(
    @Param('holdId', new ParseUUIDPipe({ version: '7' })) holdId: string,
  ): Promise<RefundEligibilityView> {
    const e = await this.refunds.canRefund(holdId);
    return {
      holdId: e.holdId,
      canRefund: e.canRefund,
      maxRefundableCents: Number(e.maxRefundableCents),
      reason: e.reason,
    };
  }

  // ── Mutation (admin lever) ─────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    operationId: 'createRefund',
    summary: 'Issue a refund (full or partial) — PayFast Refund API + escrow state flip.',
  })
  @ApiResponse({ status: 201, type: RefundView })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateRefundDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RefundView> {
    if (!dto.holdId && !dto.transactionId) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        detail: 'One of holdId or transactionId is required.',
      });
    }
    if (!dto.full && dto.refundCents === undefined) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        detail: 'Either refundCents must be provided or full must be true.',
      });
    }

    const result = await this.idempotency.run(
      {
        endpoint: 'POST /v1/refunds',
        userId: user.sub,
        idempotencyKey,
        requestBody: dto,
      },
      async () => ({
        status: 201,
        body: toRefundView(
          await this.refunds.issueRefund({
            holdId: dto.holdId,
            transactionId: dto.transactionId,
            refundCents: dto.refundCents !== undefined ? BigInt(dto.refundCents) : undefined,
            full: dto.full,
            reason: dto.reason,
            faultParty: dto.faultParty,
            actorId: user.sub,
            traceparent: req.headers['traceparent']?.toString(),
            tracestate: req.headers['tracestate']?.toString(),
          }),
        ),
      }),
    );
    if (result.replayed) res.setHeader('Idempotency-Replay', 'true');
    return result.body;
  }
}
