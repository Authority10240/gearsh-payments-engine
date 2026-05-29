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
import {
  FreezeHoldDto,
  ListHoldsQueryDto,
  PartialRefundHoldDto,
  ReleaseHoldDto,
  RefundHoldDto,
  ResolveHoldDto,
  ResolveSplitHoldDto,
} from './dto/escrow.dto';
import { EscrowHoldListResponse, EscrowHoldView, toEscrowHoldView } from './dto/escrow.view';
import { EscrowService } from './escrow.service';

/**
 * Admin REST surface for escrow holds (gearsh-payments-engine.md §API surface).
 * Every route requires the ADMIN role; the AdminGuard double-checks the JWT
 * `roles` claim AND the session-id denylist.
 *
 * Mutation routes accept an Idempotency-Key header (conventions §11). Replays
 * with the SAME body return the cached response with `Idempotency-Replay: true`;
 * replays with a DIFFERENT body raise IDEMPOTENCY_KEY_MISMATCH.
 */
@ApiTags('escrow')
@ApiBearerAuth()
@Controller('v1/escrow/holds')
@UseGuards(AdminGuard)
export class EscrowController {
  constructor(
    private readonly escrow: EscrowService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ operationId: 'getEscrowHold', summary: 'Hold detail (admin).' })
  @ApiOkResponse({ type: EscrowHoldView })
  async getById(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
  ): Promise<EscrowHoldView> {
    return toEscrowHoldView(await this.escrow.getById(id));
  }

  @Get()
  @ApiOperation({ operationId: 'listEscrowHolds', summary: 'List holds (admin).' })
  @ApiOkResponse({ type: EscrowHoldListResponse })
  async list(@Query() query: ListHoldsQueryDto): Promise<EscrowHoldListResponse> {
    const page = await this.escrow.list({
      artistId: query.artistId,
      state: query.state,
      limit: query.limit,
      cursor: query.cursor,
    });
    return {
      data: page.data.map(toEscrowHoldView),
      pageInfo: {
        hasNextPage: page.pageInfo.hasNextPage,
        // page.pageInfo.nextCursor is already the right cursor (encoded by
        // buildPage); we keep the explicit re-encode reference here for the
        // doc-author who's chasing pagination compatibility with conventions §6.
        nextCursor: page.pageInfo.nextCursor,
      },
    };
  }

  // ── Mutations (admin lever; PAY-006 subscribers call the service directly) ─

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'releaseEscrowHold',
    summary: 'Release a HELD or PARTIALLY_REFUNDED hold to the artist (admin).',
  })
  @ApiResponse({ status: 200, type: EscrowHoldView })
  async release(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: ReleaseHoldDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EscrowHoldView> {
    const result = await this.idempotency.run(
      {
        endpoint: `POST /v1/escrow/holds/${id}/release`,
        userId: user.sub,
        idempotencyKey,
        requestBody: dto,
      },
      async () => ({
        status: 200,
        body: toEscrowHoldView(
          await this.escrow.release(id, {
            actorId: user.sub,
            note: dto.reason ?? null,
            traceparent: req.headers['traceparent']?.toString(),
            tracestate: req.headers['tracestate']?.toString(),
          }),
        ),
      }),
    );
    if (result.replayed) res.setHeader('Idempotency-Replay', 'true');
    return result.body;
  }

  @Post(':id/refund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'refundEscrowHold',
    summary: 'Full refund of a HELD hold to the client (admin).',
  })
  @ApiResponse({ status: 200, type: EscrowHoldView })
  async refund(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: RefundHoldDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EscrowHoldView> {
    const result = await this.idempotency.run(
      {
        endpoint: `POST /v1/escrow/holds/${id}/refund`,
        userId: user.sub,
        idempotencyKey,
        requestBody: dto,
      },
      async () => ({
        status: 200,
        body: toEscrowHoldView(
          await this.escrow.refund(id, {
            faultParty: dto.faultParty ?? 'CLIENT',
            reason: dto.reason ?? null,
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

  @Post(':id/partial-refund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'partialRefundEscrowHold',
    summary: 'Partial refund (admin). Running total tracked on the hold.',
  })
  @ApiResponse({ status: 200, type: EscrowHoldView })
  async partialRefund(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: PartialRefundHoldDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EscrowHoldView> {
    const result = await this.idempotency.run(
      {
        endpoint: `POST /v1/escrow/holds/${id}/partial-refund`,
        userId: user.sub,
        idempotencyKey,
        requestBody: dto,
      },
      async () => ({
        status: 200,
        body: toEscrowHoldView(
          await this.escrow.partialRefund(id, BigInt(dto.amountCents), {
            faultParty: dto.faultParty ?? 'CLIENT',
            reason: dto.reason,
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

  @Post(':id/freeze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'freezeEscrowHold',
    summary: 'Freeze a hold on dispute (admin lever; subscribers call service directly).',
  })
  @ApiResponse({ status: 200, type: EscrowHoldView })
  async freeze(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: FreezeHoldDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EscrowHoldView> {
    const result = await this.idempotency.run(
      {
        endpoint: `POST /v1/escrow/holds/${id}/freeze`,
        userId: user.sub,
        idempotencyKey,
        requestBody: dto,
      },
      async () => ({
        status: 200,
        body: toEscrowHoldView(
          await this.escrow.freeze(id, {
            reason: dto.reason,
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

  @Post(':id/resolve-release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'resolveEscrowReleaseToArtist',
    summary: 'Resolve a DISPUTED hold by releasing to the artist.',
  })
  @ApiResponse({ status: 200, type: EscrowHoldView })
  async resolveRelease(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: ResolveHoldDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EscrowHoldView> {
    const result = await this.idempotency.run(
      {
        endpoint: `POST /v1/escrow/holds/${id}/resolve-release`,
        userId: user.sub,
        idempotencyKey,
        requestBody: dto,
      },
      async () => ({
        status: 200,
        body: toEscrowHoldView(
          await this.escrow.resolveRelease(id, {
            resolutionNotes: dto.resolutionNotes ?? null,
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

  @Post(':id/resolve-refund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'resolveEscrowRefundToClient',
    summary: 'Resolve a DISPUTED hold by refunding the client.',
  })
  @ApiResponse({ status: 200, type: EscrowHoldView })
  async resolveRefund(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: ResolveHoldDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EscrowHoldView> {
    const result = await this.idempotency.run(
      {
        endpoint: `POST /v1/escrow/holds/${id}/resolve-refund`,
        userId: user.sub,
        idempotencyKey,
        requestBody: dto,
      },
      async () => ({
        status: 200,
        body: toEscrowHoldView(
          await this.escrow.resolveRefund(id, {
            resolutionNotes: dto.resolutionNotes ?? null,
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

  @Post(':id/resolve-split')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'resolveEscrowSplit',
    summary: 'Resolve a DISPUTED hold by splitting between artist and client.',
  })
  @ApiResponse({ status: 200, type: EscrowHoldView })
  async resolveSplit(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: ResolveSplitHoldDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EscrowHoldView> {
    const result = await this.idempotency.run(
      {
        endpoint: `POST /v1/escrow/holds/${id}/resolve-split`,
        userId: user.sub,
        idempotencyKey,
        requestBody: dto,
      },
      async () => ({
        status: 200,
        body: toEscrowHoldView(
          await this.escrow.resolveSplit(id, BigInt(dto.artistCents), BigInt(dto.clientCents), {
            resolutionNotes: dto.resolutionNotes ?? null,
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
