import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EscrowState,
  LedgerAccount,
  LedgerDirection,
  PayoutState,
  Prisma,
  ReconciliationRun,
  ReconciliationRunState,
  RefundState,
  TransactionState,
} from '@prisma/client';
import { APP_CONFIG } from '../../config/app-config.token';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { PayFastClient } from '../../infra/payfast/payfast.client';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';

/**
 * Canonical finding shape persisted into `reconciliation_runs.findings`. The
 * `code` is the stable identifier dashboards key off; `severity` separates
 * "alert me" (HIGH) from "log only" (LOW / INFO). `context` is free-form
 * structured data per finding type.
 *
 * Exported so the admin REST projection + the unit specs can type-check the
 * payload they assert on.
 */
export interface ReconciliationFinding {
  code:
    | 'INVARIANT_A_EVENT_IMBALANCE'
    | 'INVARIANT_B_ESCROW_LIABILITY_DRIFT'
    | 'INVARIANT_C_PLATFORM_REVENUE_NEGATIVE'
    | 'PAYFAST_TRANSACTION_MISSING_LOCAL'
    | 'PAYFAST_REFUND_MISSING_LOCAL'
    | 'PAYFAST_PAYOUT_MISSING_LOCAL'
    | 'PAYFAST_RECONCILIATION_SKIPPED';
  severity: 'INFO' | 'LOW' | 'HIGH';
  detail: string;
  context?: Record<string, unknown>;
}

export interface ReconciliationOutcome {
  runId: string;
  asOfDate: string;
  findingsCount: number;
  alertSent: boolean;
  state: ReconciliationRunState;
}

/**
 * Adapter for fetching PayFast's transaction / refund / payout history for the
 * previous SAST day. The default implementation is a "no-op" — PayFast's
 * reporting API isn't wired in PAY-001..006 and the live integration is a
 * follow-up ticket. The reconciliation service degrades-on-missing-history per
 * the same convention as PayFastClient (PAY-002 §8.8): when the adapter
 * returns `null` we log + record a SKIPPED finding rather than failing the run.
 *
 * Override this via DI in tests / future tickets to actually call the PayFast
 * reporting endpoint.
 */
export interface PayFastDailyHistory {
  transactions: Array<{ pfPaymentId: string; amountCents: bigint; status: string }>;
  refunds: Array<{ gatewayRefundId: string; amountCents: bigint }>;
  payouts: Array<{ gatewayPayoutId: string; amountCents: bigint }>;
}

/** Token for the optional history adapter — registered by the module. */
export const PAYFAST_RECONCILIATION_HISTORY = Symbol('PAYFAST_RECONCILIATION_HISTORY');

export interface PayFastReconciliationHistoryAdapter {
  /** Returns `null` when the adapter can't fetch (no creds / not implemented). */
  fetchForDate(asOfDate: Date): Promise<PayFastDailyHistory | null>;
}

/**
 * Nightly reconciliation orchestrator (PAY-007). Runs the three local
 * invariants over the previous SAST day plus the PayFast vs local
 * cross-check when history is available. Persists one `reconciliation_runs`
 * row per invocation; that row IS the audit trail.
 *
 * Invoked by ReconciliationJob (the cron) and the admin manual-trigger
 * endpoint (POST /v1/admin/reconciliation/run).
 *
 * Invariants (gearsh-payments-engine.md §Reconciliation, §Ledger invariants):
 *   A. Per-event balance: Σ DEBIT = Σ CREDIT for every `escrow_event` whose
 *      ledger entries land in the day's window. The escrow state machine
 *      (PAY-003) asserts this at write-time too — this is the cold safety net.
 *   B. ESCROW_LIABILITY equals the running held amount across `escrow_holds`.
 *      Drift above `RECONCILIATION_ALERT_THRESHOLD_CENTS` is alert-worthy.
 *   C. PLATFORM_REVENUE is non-negative. A negative net balance means more was
 *      reversed (artist-fault refund §8.5) than ever booked — almost always a
 *      ledger bug.
 *
 * PayFast cross-check (§Reconciliation step 4): every COMPLETE PayFast
 * transaction MUST appear in local `transactions` (SUCCEEDED with matching
 * `gateway_txn_id`); same for refunds + payouts.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly payfast: PayFastClient,
    @Inject(PAYFAST_RECONCILIATION_HISTORY)
    private readonly history: PayFastReconciliationHistoryAdapter,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ────────────────────────────────────────────────────────────────────────

  /** Run reconciliation for the supplied SAST day (defaults to yesterday). */
  async runForDate(asOfDate?: Date): Promise<ReconciliationOutcome> {
    const target = asOfDate ? startOfSastDay(asOfDate) : previousSastDay();
    const run = await this.prisma.reconciliationRun.create({
      data: { asOfDate: target, state: ReconciliationRunState.RUNNING },
    });
    this.logger.log(`reconciliation start runId=${run.id} asOfDate=${dateToYmd(target)}`);

    const findings: ReconciliationFinding[] = [];
    try {
      const windowStart = target;
      const windowEnd = new Date(target.getTime() + 24 * 60 * 60 * 1000);

      // Invariant A
      const aFindings = await this.checkInvariantAForWindow(windowStart, windowEnd);
      findings.push(...aFindings);

      // Invariant B
      const bFindings = await this.checkInvariantB();
      findings.push(...bFindings);

      // Invariant C
      const cFindings = await this.checkInvariantC();
      findings.push(...cFindings);

      // PayFast cross-check (degrade-on-missing-creds).
      if (!this.payfast.enabled) {
        findings.push({
          code: 'PAYFAST_RECONCILIATION_SKIPPED',
          severity: 'INFO',
          detail: 'PayFast credentials are not configured — skipping gateway cross-check.',
        });
        this.logger.warn('reconciliation: PayFast not configured — skipping cross-check');
      } else {
        const history = await this.history.fetchForDate(target);
        if (history === null) {
          findings.push({
            code: 'PAYFAST_RECONCILIATION_SKIPPED',
            severity: 'INFO',
            detail: 'PayFast reporting adapter returned no history for the day.',
          });
        } else {
          const payfastFindings = await this.checkPayFastAgainstLocal(
            history,
            windowStart,
            windowEnd,
          );
          findings.push(...payfastFindings);
        }
      }

      const alertWorthy = findings.some((f) => f.severity === 'HIGH');
      if (alertWorthy) {
        // External alerting hook is operational — we log at error and surface
        // the structured payload so consumers (Slack / PagerDuty / log-based
        // alerting) can route. Keeps the cron free of HTTP coupling.
        this.logger.error(
          `reconciliation alert runId=${run.id} findings=${findings.length} ${JSON.stringify(
            findings.filter((f) => f.severity === 'HIGH'),
          )}`,
        );
      }

      const finished = await this.prisma.reconciliationRun.update({
        where: { id: run.id },
        data: {
          state: ReconciliationRunState.COMPLETED,
          completedAt: new Date(),
          findings: findings as unknown as Prisma.InputJsonValue,
          findingsCount: findings.length,
          alertSent: alertWorthy,
        },
      });
      this.logger.log(
        `reconciliation done runId=${run.id} findings=${finished.findingsCount} alert=${finished.alertSent}`,
      );
      return {
        runId: finished.id,
        asOfDate: dateToYmd(finished.asOfDate),
        findingsCount: finished.findingsCount,
        alertSent: finished.alertSent,
        state: finished.state,
      };
    } catch (err) {
      this.logger.error(`reconciliation FAILED runId=${run.id} error=${(err as Error).message}`);
      await this.prisma.reconciliationRun
        .update({
          where: { id: run.id },
          data: {
            state: ReconciliationRunState.FAILED,
            completedAt: new Date(),
            findings: [
              ...findings,
              {
                code: 'INVARIANT_A_EVENT_IMBALANCE',
                severity: 'HIGH',
                detail: (err as Error).message,
              },
            ] as unknown as Prisma.InputJsonValue,
            findingsCount: findings.length + 1,
          },
        })
        .catch(() => {
          /* swallow — already logged */
        });
      throw err;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Invariant checks (exported helpers for unit tests)
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Invariant A — per-event balance. Walk every `escrow_event` with at least
   * one ledger_entry created in the SAST window and assert Σ DEBIT = Σ CREDIT.
   *
   * We bound the scan to events whose ledger entries fall in the window rather
   * than the events themselves so a retroactive replay (same event, fresh
   * entries) is still caught.
   */
  async checkInvariantAForWindow(
    windowStart: Date,
    windowEnd: Date,
  ): Promise<ReconciliationFinding[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ event_id: string; debit_total: bigint; credit_total: bigint }>
    >`
      SELECT
        le.event_id::text AS event_id,
        COALESCE(SUM(CASE WHEN le.direction = 'DEBIT' THEN le.amount_cents ELSE 0 END), 0)::bigint AS debit_total,
        COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount_cents ELSE 0 END), 0)::bigint AS credit_total
      FROM ledger_entries le
      WHERE le.created_at >= ${windowStart}
        AND le.created_at < ${windowEnd}
      GROUP BY le.event_id
    `;

    const findings: ReconciliationFinding[] = [];
    for (const r of rows) {
      const debit = BigInt(r.debit_total ?? 0);
      const credit = BigInt(r.credit_total ?? 0);
      if (debit !== credit) {
        findings.push({
          code: 'INVARIANT_A_EVENT_IMBALANCE',
          severity: 'HIGH',
          detail: `Event ${r.event_id} has Σ DEBIT ${debit} != Σ CREDIT ${credit}.`,
          context: {
            eventId: r.event_id,
            debitCents: debit.toString(),
            creditCents: credit.toString(),
          },
        });
      }
    }
    return findings;
  }

  /**
   * Invariant B — ESCROW_LIABILITY (Σ CREDIT − Σ DEBIT on the LIABILITY
   * account) MUST equal Σ (amount_cents − partially_refunded_amount_cents)
   * across HELD + PARTIALLY_REFUNDED + DISPUTED escrow holds.
   *
   * We add DISPUTED in addition to the spec's HELD + PARTIALLY_REFUNDED
   * because the FREEZE transition (PAY-003) leaves funds in
   * ESCROW_LIABILITY — DISPUTED holds are "held but disputed", not "released".
   */
  async checkInvariantB(): Promise<ReconciliationFinding[]> {
    const ledger = await this.computeAccountBalanceCents(LedgerAccount.ESCROW_LIABILITY);

    const holds = await this.prisma.escrowHold.findMany({
      where: {
        state: { in: [EscrowState.HELD, EscrowState.PARTIALLY_REFUNDED, EscrowState.DISPUTED] },
      },
      select: { amountCents: true, partiallyRefundedAmountCents: true },
    });
    let heldRemaining = 0n;
    for (const h of holds) {
      heldRemaining += h.amountCents - h.partiallyRefundedAmountCents;
    }

    const drift = ledger - heldRemaining;
    const absDrift = drift < 0n ? -drift : drift;
    const threshold = BigInt(this.config.reconciliation.alertThresholdCents);
    if (absDrift > 0n) {
      const severity: ReconciliationFinding['severity'] = absDrift > threshold ? 'HIGH' : 'LOW';
      return [
        {
          code: 'INVARIANT_B_ESCROW_LIABILITY_DRIFT',
          severity,
          detail: `ESCROW_LIABILITY ledger balance ${ledger} differs from held funds ${heldRemaining} by ${drift}.`,
          context: {
            ledgerBalanceCents: ledger.toString(),
            heldFundsCents: heldRemaining.toString(),
            driftCents: drift.toString(),
            thresholdCents: threshold.toString(),
          },
        },
      ];
    }
    return [];
  }

  /**
   * Invariant C — net PLATFORM_REVENUE must be non-negative. A negative net
   * balance is structural — refunds-issued exceeded ever-booked revenue, which
   * means the artist-fault reversal logic over-fired or a CREDIT was missed
   * at booking.
   */
  async checkInvariantC(): Promise<ReconciliationFinding[]> {
    const revenue = await this.computeAccountBalanceCents(LedgerAccount.PLATFORM_REVENUE);
    if (revenue < 0n) {
      return [
        {
          code: 'INVARIANT_C_PLATFORM_REVENUE_NEGATIVE',
          severity: 'HIGH',
          detail: `Net PLATFORM_REVENUE ledger balance is negative: ${revenue}.`,
          context: { netRevenueCents: revenue.toString() },
        },
      ];
    }
    return [];
  }

  /**
   * Match PayFast's daily transaction / refund / payout history against the
   * local rows. Returns one HIGH finding per missing row (capped at 50 to keep
   * the JSONB payload bounded — the count is the alert signal).
   */
  async checkPayFastAgainstLocal(
    history: PayFastDailyHistory,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<ReconciliationFinding[]> {
    const findings: ReconciliationFinding[] = [];
    const FINDINGS_CAP = 50;

    // Transactions
    for (const pf of history.transactions) {
      if (pf.status !== 'COMPLETE') continue;
      const local = await this.prisma.transaction.findFirst({
        where: {
          gatewayTxnId: pf.pfPaymentId,
          state: TransactionState.SUCCEEDED,
        },
      });
      if (!local) {
        findings.push({
          code: 'PAYFAST_TRANSACTION_MISSING_LOCAL',
          severity: 'HIGH',
          detail: `PayFast txn ${pf.pfPaymentId} (amount=${pf.amountCents}) has no SUCCEEDED local row.`,
          context: { pfPaymentId: pf.pfPaymentId, amountCents: pf.amountCents.toString() },
        });
      } else if (local.amountCents !== pf.amountCents) {
        findings.push({
          code: 'PAYFAST_TRANSACTION_MISSING_LOCAL',
          severity: 'HIGH',
          detail: `Amount mismatch on PayFast txn ${pf.pfPaymentId}: local=${local.amountCents} vs gateway=${pf.amountCents}.`,
          context: {
            pfPaymentId: pf.pfPaymentId,
            localAmountCents: local.amountCents.toString(),
            gatewayAmountCents: pf.amountCents.toString(),
          },
        });
      }
      if (findings.length >= FINDINGS_CAP) return findings;
    }

    for (const pf of history.refunds) {
      const local = await this.prisma.refund.findFirst({
        where: { gatewayRefundId: pf.gatewayRefundId, state: RefundState.SUCCEEDED },
      });
      if (!local) {
        findings.push({
          code: 'PAYFAST_REFUND_MISSING_LOCAL',
          severity: 'HIGH',
          detail: `PayFast refund ${pf.gatewayRefundId} (amount=${pf.amountCents}) has no SUCCEEDED local row.`,
          context: { gatewayRefundId: pf.gatewayRefundId, amountCents: pf.amountCents.toString() },
        });
      }
      if (findings.length >= FINDINGS_CAP) return findings;
    }

    for (const pf of history.payouts) {
      const local = await this.prisma.payout.findFirst({
        where: { gatewayPayoutId: pf.gatewayPayoutId, state: PayoutState.SUCCEEDED },
      });
      if (!local) {
        findings.push({
          code: 'PAYFAST_PAYOUT_MISSING_LOCAL',
          severity: 'HIGH',
          detail: `PayFast payout ${pf.gatewayPayoutId} (amount=${pf.amountCents}) has no SUCCEEDED local row.`,
          context: { gatewayPayoutId: pf.gatewayPayoutId, amountCents: pf.amountCents.toString() },
        });
      }
      if (findings.length >= FINDINGS_CAP) return findings;
    }

    // Touch the window vars so the lint rule doesn't flag them; they're
    // retained for future filtering when the live PayFast adapter wants to
    // pre-filter by date.
    void windowStart;
    void windowEnd;

    return findings;
  }

  // ────────────────────────────────────────────────────────────────────────
  // READ surface (admin endpoints)
  // ────────────────────────────────────────────────────────────────────────

  async getRunById(id: string): Promise<ReconciliationRun> {
    const row = await this.prisma.reconciliationRun.findUnique({ where: { id } });
    if (!row) throw new AppException(ErrorCode.NOT_FOUND);
    return row;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Net account balance = Σ DEBIT − Σ CREDIT for LIABILITY-flavoured accounts
   * and Σ CREDIT − Σ DEBIT for REVENUE / PAYABLE / SETTLEMENT-flavoured ones.
   *
   * We pick the direction by account so callers don't have to remember the
   * accounting convention per account. ESCROW_LIABILITY is a LIABILITY (CREDIT
   * normal); PLATFORM_REVENUE is REVENUE (CREDIT normal); ARTIST_PAYABLE is
   * LIABILITY (CREDIT normal); REFUNDS_ISSUED is CONTRA-REVENUE (CREDIT
   * normal); PAYFAST_SETTLEMENT is ASSET (DEBIT normal); CLIENT_FUNDS is
   * ASSET (DEBIT normal).
   *
   * Returns the *normal-direction* net balance (positive when healthy).
   */
  private async computeAccountBalanceCents(account: LedgerAccount): Promise<bigint> {
    const rows = await this.prisma.ledgerEntry.groupBy({
      by: ['direction'],
      where: { account },
      _sum: { amountCents: true },
    });
    let debit = 0n;
    let credit = 0n;
    for (const r of rows) {
      const value = r._sum.amountCents ?? 0n;
      if (r.direction === LedgerDirection.DEBIT) debit = value as bigint;
      else credit = value as bigint;
    }
    if (account === LedgerAccount.PAYFAST_SETTLEMENT || account === LedgerAccount.CLIENT_FUNDS) {
      return debit - credit;
    }
    return credit - debit;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers — SAST is UTC+2 year-round (no DST in South Africa).
// ─────────────────────────────────────────────────────────────────────────────

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

export function startOfSastDay(date: Date): Date {
  // Take the SAST calendar day for `date` and return its 00:00 UTC anchor.
  const sastMillis = date.getTime() + SAST_OFFSET_MS;
  const truncated = sastMillis - (sastMillis % (24 * 60 * 60 * 1000));
  return new Date(truncated - SAST_OFFSET_MS);
}

export function previousSastDay(now: Date = new Date()): Date {
  const today = startOfSastDay(now);
  return new Date(today.getTime() - 24 * 60 * 60 * 1000);
}

function dateToYmd(date: Date): string {
  const sast = new Date(date.getTime() + SAST_OFFSET_MS);
  const y = sast.getUTCFullYear();
  const m = String(sast.getUTCMonth() + 1).padStart(2, '0');
  const d = String(sast.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
