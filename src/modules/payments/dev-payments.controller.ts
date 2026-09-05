import { Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiOperation } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/auth-user';
import { PayFastWebhookService } from './payfast-webhook.service';

/**
 * PAY-010 — dev-only payment completion (see PayFastWebhookService.devComplete).
 * Requires the intent owner's JWT; the service 404s the whole surface in
 * production, mirroring the media engine's dev-storage loop.
 */
@ApiExcludeController()
@ApiBearerAuth()
@Controller('v1/dev/payment-intents')
export class DevPaymentsController {
  constructor(private readonly webhook: PayFastWebhookService) {}

  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'devCompletePaymentIntent',
    summary: 'Simulate a COMPLETE PayFast ITN for a LOCKED intent (non-production only)',
  })
  complete(@Param('id', new ParseUUIDPipe({ version: '7' })) id: string, @CurrentUser() user: AuthUser) {
    return this.webhook.devComplete(id, user.sub, user.roles as string[]);
  }
}
