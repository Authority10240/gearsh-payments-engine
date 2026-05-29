import { Global, Module } from '@nestjs/common';
import { FxRatesController } from './fx-rates.controller';
import { FxService } from './fx.service';

@Global()
@Module({
  controllers: [FxRatesController],
  providers: [FxService],
  exports: [FxService],
})
export class FxModule {}
