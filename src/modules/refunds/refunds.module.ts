import { Module } from '@nestjs/common';
import { EscrowModule } from '../escrow/escrow.module';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';

/**
 * Refunds module (PAY-004). Owns the PayFast Refund API round-trip + the
 * `refunds` row lifecycle. Delegates escrow state flips + ledger writes to
 * EscrowService (PAY-003) via DI rather than re-implementing the state machine.
 *
 * Exports RefundsService so PAY-006's subscribers (bookings.cancelled →
 * auto-refund per policy, disputes.resolved → refund-to-client) can call
 * issueRefund(...) directly without going through HTTP.
 */
@Module({
  imports: [EscrowModule],
  controllers: [RefundsController],
  providers: [RefundsService],
  exports: [RefundsService],
})
export class RefundsModule {}
