import { Injectable, Logger } from '@nestjs/common';
import type {
  PayFastDailyHistory,
  PayFastReconciliationHistoryAdapter,
} from './reconciliation.service';

/**
 * Default PayFast daily-history adapter — a no-op stub. The PayFast reporting
 * API (transaction history) is NOT wired in PAY-001..006; the live integration
 * is a follow-up ticket. Returning `null` here trips the reconciliation
 * service's "skip with INFO finding" branch, matching the degrade-on-missing-
 * creds convention from PayFastClient (business-rules §8.8).
 *
 * Replace this provider in DI (or extend it once the reporting endpoint is
 * provisioned) to actually compare local rows against PayFast's view.
 */
@Injectable()
export class NoopPayFastHistoryAdapter implements PayFastReconciliationHistoryAdapter {
  private readonly logger = new Logger(NoopPayFastHistoryAdapter.name);

  async fetchForDate(asOfDate: Date): Promise<PayFastDailyHistory | null> {
    this.logger.debug(
      `PayFast history adapter is the noop default — no cross-check for ${asOfDate.toISOString()}.`,
    );
    return null;
  }
}
