import { Global, Module } from '@nestjs/common';
import { AdminFxController } from './admin-fx.controller';
import { FxRatesController } from './fx-rates.controller';
import { FxService } from './fx.service';

@Global()
@Module({
  controllers: [FxRatesController, AdminFxController],
  providers: [FxService],
  exports: [FxService],
})
export class FxModule {}
