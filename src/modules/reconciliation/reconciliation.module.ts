import { Module } from '@nestjs/common';
import { ReconciliationJob } from './jobs/reconciliation.job';
import { PAYFAST_RECONCILIATION_HISTORY, ReconciliationService } from './reconciliation.service';
import { NoopPayFastHistoryAdapter } from './payfast-history.adapter';

/**
 * Reconciliation module (PAY-007). Owns:
 *
 *   - the nightly 02:30 SAST cron (ReconciliationJob),
 *   - the invariant + PayFast cross-check service (ReconciliationService),
 *   - the no-op PayFast history adapter (replaced when the reporting endpoint
 *     ships in a follow-up).
 *
 * The admin REST surface for `/v1/admin/reconciliation/*` lives in the admin
 * module — it injects ReconciliationService directly.
 */
@Module({
  providers: [
    ReconciliationJob,
    ReconciliationService,
    NoopPayFastHistoryAdapter,
    {
      provide: PAYFAST_RECONCILIATION_HISTORY,
      useExisting: NoopPayFastHistoryAdapter,
    },
  ],
  exports: [ReconciliationService, ReconciliationJob],
})
export class ReconciliationModule {}
