import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentIntentsService } from './payment-intents.service';
import { PayFastWebhookController } from './webhook.controller';

@Module({
  controllers: [PaymentsController, PayFastWebhookController],
  providers: [PaymentIntentsService],
  exports: [PaymentIntentsService],
})
export class PaymentsModule {}
