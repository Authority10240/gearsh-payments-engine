import { Module } from '@nestjs/common';
import { EscrowController } from './escrow.controller';
import { EscrowService } from './escrow.service';
import { LedgerService } from './ledger.service';

/**
 * Escrow module (PAY-003). Owns the hold lifecycle state machine, the
 * double-entry ledger writer, and the admin REST surface for /v1/escrow/holds.
 *
 * Exports EscrowService + LedgerService so subscribers (PAY-006) and the
 * refund flow (PAY-004) can call the same orchestrator without re-implementing
 * the state-machine + ledger glue.
 */
@Module({
  controllers: [EscrowController],
  providers: [EscrowService, LedgerService],
  exports: [EscrowService, LedgerService],
})
export class EscrowModule {}
