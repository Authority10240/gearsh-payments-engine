import { Global, Module } from '@nestjs/common';
import { PayFastClient } from './payfast.client';

@Global()
@Module({
  providers: [PayFastClient],
  exports: [PayFastClient],
})
export class PayFastModule {}
