import { Global, Module } from '@nestjs/common';
import { IdempotencyService } from '../../common/idempotency.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService, IdempotencyService],
  exports: [RedisService, IdempotencyService],
})
export class RedisModule {}
