import { Module } from '@nestjs/common';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

/**
 * Payments-admin module (PAY-007). Adds the composite reconciliation /
 * transactions / escrow balances / stuck-states / audit-log surface plus the
 * audit middleware (registered in AppModule.configure(), not here, so EVERY
 * `/v1/admin/*` route — including those owned by other modules — picks it up).
 *
 * Does NOT import EscrowModule / RefundsModule / PayoutsModule:
 *   - their admin controllers are already registered globally;
 *   - importing them again would double-register routes;
 *   - the admin composite service reads the relevant tables directly via
 *     Prisma (the projections want shapes the per-module services don't
 *     expose publicly).
 */
@Module({
  imports: [ReconciliationModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
