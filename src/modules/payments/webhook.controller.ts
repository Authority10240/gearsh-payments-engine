import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';

/**
 * PayFast ITN (Instant Transaction Notification) webhook.
 *
 * PAY-002: real implementation will (per gearsh-payments-engine.md §PayFast
 * integration "ITN flow"):
 *   1. Verify source IP against PAYFAST_IP_WHITELIST.
 *   2. Re-compute signature over received params via PayFastClient.
 *   3. Server-to-server validate call to PayFast.
 *   4. Verify amount + merchant_id match the intent.
 *   5. On success: update transaction, atomically create escrow hold in the
 *      same DB tx, enqueue payments.succeeded + escrow.held in the outbox.
 *
 * Stubbed here so the route exists in Swagger and so the wiring (Public guard
 * skip; raw-form body parsing in main.ts) lands with the rest of the engine.
 */
@ApiTags('webhooks')
@Controller('v1/webhooks/payfast')
export class PayFastWebhookController {
  @Public()
  @Post()
  @HttpCode(HttpStatus.NOT_IMPLEMENTED)
  @ApiOperation({
    operationId: 'payfastItn',
    summary: 'PayFast ITN — STUB (PAY-002 implements signature + validate + escrow hold).',
  })
  notImplemented(): never {
    throw new AppException(ErrorCode.SERVICE_UNAVAILABLE, {
      detail: 'PayFast ITN handler is not implemented yet (see PAY-002).',
    });
  }
}
