import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { PayFastWebhookService } from './payfast-webhook.service';

/**
 * PayFast ITN (Instant Transaction Notification) webhook (PAY-002).
 *
 * The pipeline is encapsulated in PayFastWebhookService — see that class for
 * the documented step ordering. This controller is intentionally thin: pull
 * the form-encoded body + the source IP, hand off, return 200. PayFast cares
 * only about the 200 (any other status triggers an ITN retry, which is fine —
 * dedup is by (paymentIntentId, pfPaymentId, payment_status)).
 *
 * @Public() so the global JwtAuthGuard skips this route. The webhook is
 * authenticated by IP whitelist + signature + s2s validate — there is no
 * platform JWT on PayFast's side.
 */
@ApiTags('webhooks')
@Controller('v1/webhooks/payfast')
export class PayFastWebhookController {
  constructor(private readonly handler: PayFastWebhookService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'payfastItn',
    summary:
      'PayFast ITN — IP-whitelisted, signature-verified, s2s-validated; atomically captures the transaction and creates the escrow hold.',
  })
  async receive(
    @Req() req: Request,
    @Body() body: Record<string, string>,
  ): Promise<{ status: 'ok' }> {
    // Express resolves `req.ip` from the first trusted proxy hop (main.ts sets
    // `trust proxy = 1`), falling back to the socket peer in dev. PayFast
    // posts as application/x-www-form-urlencoded — the global urlencoded()
    // parser in main.ts populates `body`.
    const sourceIp = req.ip ?? req.socket.remoteAddress ?? '';

    return this.handler.handle({
      params: body ?? {},
      sourceIp,
      traceparent: req.traceparent,
    });
  }
}
