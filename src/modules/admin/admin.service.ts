import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EscrowState,
  LedgerAccount,
  LedgerDirection,
  PayoutState,
  Prisma,
  ReconciliationRun,
  RefundState,
  Transaction,
} from '@prisma/client';
import { APP_CONFIG } from '../../config/app-config.token';
import type { AppConfig } from '../../config/configuration';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';
import { buildPage, clampLimit, decodeCursor, type Page } from '../../common/pagination';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import type {
  ListAdminTransactionsQuery,
  ListAuditQuery,
  ListLedgerEntriesQuery,
  ListReconciliationRunsQuery,
} from './dto/admin.dto';

/** Currency-keyed view of one account's ledger balance. */
export interface AccountBalance {
  account: LedgerAccount;
  netCents: string;
  debitCents: string;
  creditCents: string;
}

/**
 * Admin module service (PAY-007). Hosts the composite payments-admin views:
 *
 *   - reconciliation runs list / detail / manual trigger;
 *   - transactions list (cursor-paginated);
 *   - escrow per-account balances + ledger by date;
 *   - the "stuck states" surface (refunds / holds / payouts / disputes);
 *   - audit-log query.
 *
 * Does NOT duplicate the per-module admin endpoints (escrow holds release/
 * refund/freeze, refunds POST, payouts retry/cancel/list). Those live in
 * their owning modules; the audit middleware in AppModule catches every
 * `/v1/admin/*` route regardless of which module declared it.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  // ── Reconciliation views ────────────────────────────────────────────────

  async listReconciliationRuns(
    query: ListReconciliationRunsQuery,
  ): Promise<Page<ReconciliationRun>> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const where: Prisma.ReconciliationRunWhereInput = {};

    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    if (cursor) {
      where.OR = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
    }

    const rows = await this.prisma.reconciliationRun.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return buildPage(rows, limit);
  }

  async getReconciliationRun(id: string): Promise<ReconciliationRun> {
    return this.reconciliation.getRunById(id);
  }

  /** Admin manual trigger — defaults to yesterday (SAST) when no asOfDate is
   *  provided. Returns the new run id immediately; the run itself is sync. */
  async triggerReconciliation(asOfDate?: string): Promise<{ runId: string }> {
    const target = asOfDate ? parseYmdAsSast(asOfDate) : undefined;
    const outcome = await this.reconciliation.runForDate(target);
    return { runId: outcome.runId };
  }

  // ── Transactions ────────────────────────────────────────────────────────

  async listTransactions(query: ListAdminTransactionsQuery): Promise<Page<Transaction>> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const where: Prisma.TransactionWhereInput = {};

    if (query.intentId) where.paymentIntentId = query.intentId;
    if (query.state) where.state = query.state;
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    if (cursor) {
      where.OR = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
    }

    const rows = await this.prisma.transaction.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return buildPage(rows, limit);
  }

  // ── Escrow balances + ledger by date ────────────────────────────────────

  /**
   * Per-account net balance. ASSET-flavoured accounts (PAYFAST_SETTLEMENT,
   * CLIENT_FUNDS) report DEBIT − CREDIT; the rest report CREDIT − DEBIT. The
   * raw debit/credit totals are also returned so the admin UI can show "Σ
   * DEBIT − Σ CREDIT" alongside the normalised net.
   */
  async getEscrowBalances(): Promise<{ data: AccountBalance[] }> {
    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['account', 'direction'],
      _sum: { amountCents: true },
    });

    const accounts: LedgerAccount[] = [
      LedgerAccount.CLIENT_FUNDS,
      LedgerAccount.ESCROW_LIABILITY,
      LedgerAccount.PLATFORM_REVENUE,
      LedgerAccount.ARTIST_PAYABLE,
      LedgerAccount.PAYFAST_SETTLEMENT,
      LedgerAccount.REFUNDS_ISSUED,
    ];

    const out: AccountBalance[] = accounts.map((account) => {
      const debit =
        (grouped.find((g) => g.account === account && g.direction === LedgerDirection.DEBIT)?._sum
          .amountCents as bigint | null | undefined) ?? 0n;
      const credit =
        (grouped.find((g) => g.account === account && g.direction === LedgerDirection.CREDIT)?._sum
          .amountCents as bigint | null | undefined) ?? 0n;
      const isAsset =
        account === LedgerAccount.PAYFAST_SETTLEMENT || account === LedgerAccount.CLIENT_FUNDS;
      const net = isAsset ? debit - credit : credit - debit;
      return {
        account,
        debitCents: debit.toString(),
        creditCents: credit.toString(),
        netCents: net.toString(),
      };
    });

    return { data: out };
  }

  async listLedgerEntriesByDate(query: ListLedgerEntriesQuery): Promise<
    Page<{
      id: string;
      holdId: string;
      eventId: string;
      account: LedgerAccount;
      direction: LedgerDirection;
      amountCents: string;
      currency: string;
      createdAt: Date;
    }>
  > {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const targetDay = query.date ? parseYmdAsSast(query.date) : startOfSastDay(new Date());
    const windowStart = targetDay;
    const windowEnd = new Date(targetDay.getTime() + 24 * 60 * 60 * 1000);

    const where: Prisma.LedgerEntryWhereInput = {
      createdAt: { gte: windowStart, lt: windowEnd },
    };
    if (cursor) {
      where.OR = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
    }

    const rows = await this.prisma.ledgerEntry.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const page = buildPage(rows, limit);
    return {
      data: page.data.map((r) => ({
        id: r.id,
        holdId: r.holdId,
        eventId: r.eventId,
        account: r.account,
        direction: r.direction,
        amountCents: r.amountCents.toString(),
        currency: r.currency,
        createdAt: r.createdAt,
      })),
      pageInfo: page.pageInfo,
    };
  }

  // ── Stuck states ────────────────────────────────────────────────────────

  /** Refunds in FAILED whose underlying escrow hold is still HELD — the
   *  PayFast round-trip never made it back. */
  async stuckRefunds(limit?: number) {
    const cap = clampLimit(limit);
    // Resolve via the refunds → transactions → intent → hold chain because
    // refunds don't carry holdId directly.
    const failed = await this.prisma.refund.findMany({
      where: { state: RefundState.FAILED },
      orderBy: { createdAt: 'desc' },
      take: cap,
      include: { transaction: true },
    });
    const stuck = [];
    for (const refund of failed) {
      const hold = await this.prisma.escrowHold.findFirst({
        where: { paymentIntentId: refund.transaction.paymentIntentId },
      });
      if (hold && hold.state === EscrowState.HELD) {
        stuck.push({
          refundId: refund.id,
          holdId: hold.id,
          amountCents: refund.amountCents.toString(),
          failureReason: refund.failureReason,
          failedAt: refund.updatedAt,
        });
      }
    }
    return { data: stuck };
  }

  /** Holds HELD where heldAt is older than the configured threshold — the
   *  booking side never told Payments to release/refund. */
  async stuckHolds(limit?: number) {
    const cap = clampLimit(limit);
    const cutoff = new Date(
      Date.now() - this.config.reconciliation.stuckHoldHours * 60 * 60 * 1000,
    );
    const rows = await this.prisma.escrowHold.findMany({
      where: { state: EscrowState.HELD, heldAt: { lt: cutoff } },
      orderBy: { heldAt: 'asc' },
      take: cap,
    });
    return {
      data: rows.map((h) => ({
        holdId: h.id,
        bookingId: h.bookingId,
        artistId: h.artistId,
        amountCents: h.amountCents.toString(),
        heldAt: h.heldAt,
        ageHours: Math.floor((Date.now() - h.heldAt.getTime()) / (60 * 60 * 1000)),
      })),
      thresholdHours: this.config.reconciliation.stuckHoldHours,
    };
  }

  /** Payouts QUEUED with dispatchAfter older than the configured threshold —
   *  the dispatcher cron has had multiple chances and isn't picking them up. */
  async stuckPayouts(limit?: number) {
    const cap = clampLimit(limit);
    const cutoff = new Date(
      Date.now() - this.config.reconciliation.stuckPayoutHours * 60 * 60 * 1000,
    );
    const rows = await this.prisma.payout.findMany({
      where: { state: PayoutState.QUEUED, dispatchAfter: { lt: cutoff } },
      orderBy: { dispatchAfter: 'asc' },
      take: cap,
    });
    return {
      data: rows.map((p) => ({
        payoutId: p.id,
        artistId: p.artistId,
        amountCents: p.amountCents.toString(),
        dispatchAfter: p.dispatchAfter,
        attempts: p.attempts,
      })),
      thresholdHours: this.config.reconciliation.stuckPayoutHours,
    };
  }

  /** Escrow holds DISPUTED with disputedAt older than the configured
   *  threshold — disputes that should be resolved by now. */
  async stuckDisputes(limit?: number) {
    const cap = clampLimit(limit);
    const cutoff = new Date(
      Date.now() - this.config.reconciliation.stuckDisputeDays * 24 * 60 * 60 * 1000,
    );
    const rows = await this.prisma.escrowHold.findMany({
      where: { state: EscrowState.DISPUTED, disputedAt: { lt: cutoff } },
      orderBy: { disputedAt: 'asc' },
      take: cap,
    });
    return {
      data: rows.map((h) => ({
        holdId: h.id,
        bookingId: h.bookingId,
        amountCents: h.amountCents.toString(),
        disputedAt: h.disputedAt,
        ageDays: h.disputedAt
          ? Math.floor((Date.now() - h.disputedAt.getTime()) / (24 * 60 * 60 * 1000))
          : null,
      })),
      thresholdDays: this.config.reconciliation.stuckDisputeDays,
    };
  }

  // ── Audit log query ─────────────────────────────────────────────────────

  async listAudit(query: ListAuditQuery): Promise<{
    data: Array<Record<string, unknown>>;
    pageInfo: { hasNextPage: boolean; nextCursor: string | null };
  }> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const includeBody = query.includeBody === 'true';

    const where: Prisma.AdminAuditLogWhereInput = {};
    if (query.actorId) where.actorId = query.actorId;
    if (query.action) where.action = query.action;
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    if (cursor) {
      where.OR = [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ];
    }

    const rows = await this.prisma.adminAuditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const page = buildPage(rows, limit);
    return {
      data: page.data.map((r) => projectAuditRow(r, includeBody)),
      pageInfo: page.pageInfo,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers
// ─────────────────────────────────────────────────────────────────────────────

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

function startOfSastDay(date: Date): Date {
  const sastMillis = date.getTime() + SAST_OFFSET_MS;
  const truncated = sastMillis - (sastMillis % (24 * 60 * 60 * 1000));
  return new Date(truncated - SAST_OFFSET_MS);
}

function parseYmdAsSast(ymd: string): Date {
  // "2026-05-28" → 2026-05-28 00:00 SAST → UTC midnight of the previous day.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) {
    throw new AppException(ErrorCode.VALIDATION_FAILED, {
      detail: `Invalid date "${ymd}". Expected YYYY-MM-DD.`,
    });
  }
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(utc - SAST_OFFSET_MS);
}

function projectAuditRow(
  row: {
    id: string;
    actorId: string | null;
    action: string;
    path: string;
    method: string;
    targetId: string | null;
    requestBody: Prisma.JsonValue | null;
    responseCode: number | null;
    ip: string | null;
    userAgent: string | null;
    createdAt: Date;
  },
  includeBody: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.id,
    actorId: row.actorId,
    action: row.action,
    path: row.path,
    method: row.method,
    targetId: row.targetId,
    responseCode: row.responseCode,
    ip: row.ip,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
  };
  if (includeBody) out.requestBody = row.requestBody;
  return out;
}
