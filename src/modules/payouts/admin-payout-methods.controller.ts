import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/auth-user';
import { AdminGuard } from '../../common/guards/admin.guard';
import {
  GetPayoutMethodQueryDto,
  ListPayoutMethodsQueryDto,
  RejectPayoutMethodDto,
} from './dto/payout-method.dto';
import {
  PayoutMethodListResponse,
  PayoutMethodView,
  toPayoutMethodView,
} from './dto/payout-method.view';
import { PayoutMethodsService } from './payout-methods.service';

/**
 * Admin surface for inspecting + verifying artist payout methods (PAY-005,
 * gearsh-payments-engine.md §API surface — admin payouts routes).
 *
 *   - GET    /v1/admin/payouts/methods            — list, masked, paginated.
 *   - GET    /v1/admin/payouts/methods/:id        — single, masked by default;
 *                                                   ?unmask=true returns
 *                                                   plaintext (audit gap
 *                                                   noted — admin-audit
 *                                                   middleware lands in
 *                                                   PAY-007).
 *   - POST   /v1/admin/payouts/methods/:id/verify — mark verified.
 *   - POST   /v1/admin/payouts/methods/:id/reject — unset verification, log
 *                                                   reason.
 */
@ApiTags('payouts')
@ApiBearerAuth()
@Controller('v1/admin/payouts/methods')
@UseGuards(AdminGuard)
export class AdminPayoutMethodsController {
  constructor(private readonly methods: PayoutMethodsService) {}

  @Get()
  @ApiOperation({
    operationId: 'listPayoutMethodsAdmin',
    summary: 'List artist payout methods (masked).',
  })
  @ApiOkResponse({ type: PayoutMethodListResponse })
  async list(@Query() query: ListPayoutMethodsQueryDto): Promise<PayoutMethodListResponse> {
    const page = await this.methods.listForAdmin({
      isVerified: query.isVerified,
      limit: query.limit,
      cursor: query.cursor,
    });
    // Mask each row. We pay one decrypt per row — acceptable at default
    // limit 25 / max 100. PAY-007 may cache the masked digest if this
    // becomes a perf issue.
    const data = await Promise.all(
      page.data.map(async (row) => {
        const masked = await this.methods.maskedAccountNumberFor(row);
        return toPayoutMethodView(row, { masked });
      }),
    );
    return {
      data,
      pageInfo: {
        hasNextPage: page.pageInfo.hasNextPage,
        nextCursor: page.pageInfo.nextCursor,
      },
    };
  }

  @Get(':artistUserId')
  @ApiOperation({
    operationId: 'getPayoutMethodAdmin',
    summary: 'Get a single payout method (masked unless ?unmask=true).',
  })
  @ApiQuery({ name: 'unmask', required: false, type: Boolean })
  @ApiOkResponse({ type: PayoutMethodView })
  async getOne(
    @Param('artistUserId', new ParseUUIDPipe({ version: '7' })) artistUserId: string,
    @Query() query: GetPayoutMethodQueryDto,
  ): Promise<PayoutMethodView> {
    const row = await this.methods.getForAdmin(artistUserId);
    if (query.unmask === true) {
      const plaintext = await this.methods.decryptAccountNumber(row);
      return toPayoutMethodView(row, { masked: '', plaintext });
    }
    const masked = await this.methods.maskedAccountNumberFor(row);
    return toPayoutMethodView(row, { masked });
  }

  @Post(':artistUserId/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'verifyPayoutMethod',
    summary: 'Mark a payout method as verified.',
  })
  @ApiOkResponse({ type: PayoutMethodView })
  async verify(
    @Param('artistUserId', new ParseUUIDPipe({ version: '7' })) artistUserId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<PayoutMethodView> {
    const row = await this.methods.verify(artistUserId, user.sub);
    const masked = await this.methods.maskedAccountNumberFor(row);
    return toPayoutMethodView(row, { masked });
  }

  @Post(':artistUserId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'rejectPayoutMethod',
    summary: 'Reject a payout method, unsetting verification.',
  })
  @ApiOkResponse({ type: PayoutMethodView })
  async reject(
    @Param('artistUserId', new ParseUUIDPipe({ version: '7' })) artistUserId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: RejectPayoutMethodDto,
  ): Promise<PayoutMethodView> {
    const row = await this.methods.reject(artistUserId, user.sub, dto.reason);
    const masked = await this.methods.maskedAccountNumberFor(row);
    return toPayoutMethodView(row, { masked });
  }
}
