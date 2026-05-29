import { Injectable, Logger } from '@nestjs/common';
import { Payout, PayoutState, Prisma } from '@prisma/client';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';
import { buildPage, clampLimit, decodeCursor, type Page } from '../../common/pagination';
import { PrismaService } from '../../infra/prisma/prisma.service';

export interface ListPayoutsQuery {
  state?: PayoutState;
  artistUserId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

/**
 * Admin-facing payouts service — owns the read/list/retry/cancel surface.
 *
 * The hot path (dispatcher cron) lives in PayoutDispatcherJob; this service
 * is the manual admin lever: lookups for the admin UI, a "retry now" button
 * for FAILED rows that the retry-cron's backoff hasn't yet picked up, and a
 * cancel for QUEUED rows the admin wants to redirect into a refund.
 */
@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getById(id: string): Promise<Payout> {
    const row = await this.prisma.payout.findUnique({ where: { id } });
    if (!row) throw new AppException(ErrorCode.NOT_FOUND);
    return row;
  }

  async list(query: ListPayoutsQuery): Promise<Page<Payout>> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const where: Prisma.PayoutWhereInput = {};
    if (query.state) where.state = query.state;
    if (query.artistUserId) where.artistId = query.artistUserId;
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lte: query.to } : {}),
      };
    }
    if (cursor) {
      where.OR = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
    }
    const rows = await this.prisma.payout.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return buildPage(rows, limit);
  }

  /**
   * Manually requeue a FAILED payout. Sets state back to QUEUED and bumps
   * `attempts`; the next dispatcher tick will pick it up. Idempotent: if the
   * payout is already QUEUED, returns it unchanged.
   *
   * Throws ILLEGAL_TRANSITION when called on PROCESSING / SUCCEEDED /
   * CANCELLED (the retry only makes sense from FAILED).
   */
  async retry(id: string): Promise<Payout> {
    const row = await this.prisma.payout.findUnique({ where: { id } });
    if (!row) throw new AppException(ErrorCode.NOT_FOUND);
    if (row.state === PayoutState.QUEUED) return row;
    if (row.state !== PayoutState.FAILED) {
      throw new AppException(ErrorCode.ILLEGAL_TRANSITION, {
        detail: `Payout ${id} is in ${row.state} — only FAILED payouts can be retried.`,
      });
    }
    return this.prisma.payout.update({
      where: { id },
      data: {
        state: PayoutState.QUEUED,
        attempts: { increment: 1 },
        failureReason: null,
        // Clear failed_at so the retry-cron's backoff gate doesn't double-fire.
        failedAt: null,
      },
    });
  }

  /**
   * Cancel a QUEUED payout — useful when the admin chooses to refund the
   * client instead. Sets state=CANCELLED with `cancellation_reason='ADMIN'`
   * and stamps `cancelled_at`. Idempotent on CANCELLED; throws
   * ILLEGAL_TRANSITION on any non-QUEUED, non-CANCELLED state (PROCESSING /
   * SUCCEEDED / FAILED — those are terminal/in-flight).
   */
  async cancel(id: string, opts: { reason?: string } = {}): Promise<Payout> {
    const row = await this.prisma.payout.findUnique({ where: { id } });
    if (!row) throw new AppException(ErrorCode.NOT_FOUND);
    if (row.state === PayoutState.CANCELLED) return row;
    if (row.state !== PayoutState.QUEUED) {
      throw new AppException(ErrorCode.ILLEGAL_TRANSITION, {
        detail: `Payout ${id} is in ${row.state} — only QUEUED payouts can be cancelled.`,
      });
    }
    return this.prisma.payout.update({
      where: { id },
      data: {
        state: PayoutState.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: opts.reason ?? 'ADMIN',
      },
    });
  }
}
