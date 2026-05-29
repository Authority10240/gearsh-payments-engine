import { Global, Module } from '@nestjs/common';
import { EncryptionService } from './encryption.service';

/**
 * Global crypto module — currently just the EncryptionService wrapper around
 * pgcrypto. Exported here (rather than inlined into the payouts module) so the
 * PAY-007 reconciliation module can re-use the same decrypt path for the
 * end-of-day account-number verification report without duplicating the key
 * handling.
 */
@Global()
@Module({
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class CryptoModule {}
