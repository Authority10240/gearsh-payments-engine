import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PayoutState } from '@prisma/client';
import { APP_CONFIG } from '../../../config/app-config.token';
import type { AppConfig } from '../../../config/configuration';
import { PrismaService } from '../../../infra/prisma/prisma.service';

/**
 * Every-4-hour retry job for FAILED payouts (gearsh-payments-engine.md §Jobs).
 *
 * Backoff schedule: `min(24, 2 ** attempts)` hours between attempts —
 *
 *   attempts | wait | total wall-clock since first failure
 *   ─────────┼──────┼─────────────────────────────────────
 *     0      |   1h | 1h
 *     1      |   2h | 3h
 *     2      |   4h | 7h
 *     3      |   8h | 15h
 *     4      |  16h | 31h (capped at 24h on subsequent runs)
 *     5      |   —  | no further retry (PAYOUT_MAX_ATTEMPTS)
 *
 * Eligible rows are simply re-queued (state → QUEUED, attempts++); the
 * hourly dispatcher then picks them up on its next tick.
 *
 * The retry-cron itself runs every 4h, which means the actual cadence is
 * "at most every 4h, and only when the backoff gate has elapsed" — exactly
 * the spec.
 */
@Injectable()
export class PayoutRetryJob {
  private readonly logger = new Logger(PayoutRetryJob.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  @Cron('0 */4 * * *', { timeZone: 'Africa/Johannesburg', name: 'payouts-retry' })
  async cron(): Promise<{ requeued: number }> {
    if (!this.config.payouts.retryEnabled) {
      this.logger.debug('payouts retry disabled via PAYOUT_RETRY_ENABLED');
      return { requeued: 0 };
    }
    return this.runOnce();
  }

  /**
   * Single retry tick. Walks FAILED rows, checks the per-row backoff window
   * (failed_at + min(24h, 2^attempts hours)), and re-queues those whose
   * window has elapsed. Returns the count requeued for log/visibility.
   */
  async runOnce(): Promise<{ requeued: number }> {
    const maxAttempts = this.config.payouts.maxAttempts;
    // Pull all FAILED rows that haven't exhausted the retry budget; we filter
    // by backoff in JS because the per-row cutoff varies by `attempts`.
    const candidates = await this.prisma.payout.findMany({
      where: {
        state: PayoutState.FAILED,
        attempts: { lt: maxAttempts },
      },
      orderBy: { failedAt: 'asc' },
    });
    const now = Date.now();
    let requeued = 0;
    for (const row of candidates) {
      if (!row.failedAt) continue; // shouldn't happen — defensive
      const backoffMs = backoffHoursFor(row.attempts) * 60 * 60 * 1000;
      if (row.failedAt.getTime() + backoffMs > now) continue;
      // Atomic re-queue. Guard on state=FAILED so a concurrent admin retry
      // (which already requeued) doesn't double-bump attempts.
      const r = await this.prisma.payout.updateMany({
        where: { id: row.id, state: PayoutState.FAILED },
        data: {
          state: PayoutState.QUEUED,
          attempts: { increment: 1 },
          failureReason: null,
          failedAt: null,
        },
      });
      if (r.count > 0) requeued += 1;
    }
    if (requeued > 0) {
      this.logger.log(`payouts retry tick: requeued=${requeued}`);
    }
    return { requeued };
  }
}

/**
 * Backoff schedule per spec: 1, 2, 4, 8, 16, then capped at 24h. Exported for
 * the unit spec — see modules/payouts/jobs/payout-retry.job.spec.ts.
 */
export function backoffHoursFor(attempts: number): number {
  if (attempts < 0) return 1;
  return Math.min(24, 2 ** attempts);
}
