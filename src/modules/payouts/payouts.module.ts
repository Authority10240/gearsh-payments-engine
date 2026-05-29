import { Module } from '@nestjs/common';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { AdminPayoutMethodsController } from './admin-payout-methods.controller';
import { AdminPayoutsController } from './admin-payouts.controller';
import { PayoutDispatcherJob } from './jobs/payout-dispatcher.job';
import { PayoutRetryJob } from './jobs/payout-retry.job';
import { PayoutMethodsController } from './payout-methods.controller';
import { PayoutMethodsService } from './payout-methods.service';
import { PayoutsService } from './payouts.service';

/**
 * Payouts module (PAY-005).
 *
 * Owns:
 *   - artist_payout_methods CRUD (PayoutMethodsService + 2 controllers);
 *   - admin payouts queue / detail / retry / cancel (PayoutsService +
 *     AdminPayoutsController);
 *   - hourly payout dispatcher cron (PayoutDispatcherJob);
 *   - 4-hourly payout retry cron (PayoutRetryJob).
 *
 * Does NOT own:
 *   - inserting `payouts` rows on RELEASE / RESOLVE_RELEASE / SPLIT — that's
 *     EscrowService (PAY-003), already wired;
 *   - subscriber-driven flips (PAY-006) — those will inject PayoutsService /
 *     EscrowService via DI without going through HTTP.
 *
 * Exports PayoutMethodsService + PayoutsService so future PAY-007 admin
 * composite views can read payouts + verification status without re-importing
 * Prisma directly.
 */
@Module({
  imports: [CryptoModule],
  controllers: [PayoutMethodsController, AdminPayoutMethodsController, AdminPayoutsController],
  providers: [PayoutMethodsService, PayoutsService, PayoutDispatcherJob, PayoutRetryJob],
  exports: [PayoutMethodsService, PayoutsService],
})
export class PayoutsModule {}
