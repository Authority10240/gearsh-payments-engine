import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { APP_CONFIG } from '../../../config/app-config.token';
import type { AppConfig } from '../../../config/configuration';
import { ReconciliationService, type ReconciliationOutcome } from '../reconciliation.service';

/**
 * Nightly 02:30 SAST reconciliation cron (gearsh-payments-engine.md §Jobs).
 * Africa/Johannesburg is UTC+2 year-round → 00:30 UTC == 02:30 SAST.
 *
 * Env-gated via `RECONCILIATION_ENABLED` (default true) so tests can pin the
 * scheduler off and call `runOnce()` directly without racing the tick.
 *
 * The job delegates all of the heavy lifting (invariant checks, PayFast
 * cross-check, persistence, alerting) to ReconciliationService — this class
 * is just the cron decorator + the env gate.
 */
@Injectable()
export class ReconciliationJob {
  private readonly logger = new Logger(ReconciliationJob.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Cron('30 2 * * *', { timeZone: 'Africa/Johannesburg', name: 'reconciliation' })
  async cron(): Promise<ReconciliationOutcome | { skipped: true }> {
    if (!this.config.reconciliation.enabled) {
      this.logger.debug('reconciliation disabled via RECONCILIATION_ENABLED');
      return { skipped: true };
    }
    return this.runOnce();
  }

  /**
   * Run a single reconciliation tick for the previous SAST day. Exposed
   * separately so the admin manual-trigger endpoint can re-use the same
   * service entry point (it goes through `ReconciliationService.runForDate`
   * directly, but this helper preserves the cron's "no asOfDate" semantics).
   */
  async runOnce(): Promise<ReconciliationOutcome> {
    return this.reconciliation.runForDate();
  }
}
