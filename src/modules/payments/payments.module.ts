import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentIntentsService } from './payment-intents.service';
import { DevPaymentsController } from './dev-payments.controller';
import { PayFastWebhookController } from './webhook.controller';
import { PayFastWebhookService } from './payfast-webhook.service';

@Module({
  controllers: [PaymentsController, PayFastWebhookController, DevPaymentsController],
  providers: [PaymentIntentsService, PayFastWebhookService],
  exports: [PaymentIntentsService],
})
export class PaymentsModule {}
