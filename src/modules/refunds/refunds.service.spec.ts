import { EscrowState, RefundState, TransactionType } from '@prisma/client';
import { RefundsService } from './refunds.service';
import { ErrorCode } from '../../common/problem/error-codes';
import { AppException } from '../../common/problem/app-exception';
import type {
  PayFastRefundFailure,
  PayFastRefundResult,
  PayFastRefundSuccess,
} from '../../infra/payfast/payfast.client';

/**
 * Unit coverage for RefundsService — the PAY-004 orchestrator.
 *
 * Scope:
 *   - canRefund() eligibility: terminal, fully refunded, missing charge, ok.
 *   - issueRefund() pre-flight validation: REFUND_EXCEEDS_CAPTURE, terminal hold,
 *     no charge txn (NOT_FOUND).
 *   - PayFast retry policy: 5xx twice then success → 1 SUCCEEDED row +
 *     payments.refund.succeeded outbox row, 4xx once → no retry → FAILED +
 *     PAYFAST_UPSTREAM_FAILURE.
 *
 * Mocking strategy: PrismaService + PayFastClient + EscrowService + OutboxService
 * are hand-rolled fakes — no DB. The atomic-transaction tests are covered by
 * the e2e spec; here we verify the orchestration choices.
 */
describe('RefundsService (unit)', () => {
  const HOLD_ID = '01910000-0000-7000-8000-000000000001';
  const INTENT_ID = '01910000-0000-7000-8000-000000000002';
  const CHARGE_TXN_ID = '01910000-0000-7000-8000-000000000003';
  const PF_PAYMENT_ID = 'pf-charge-99';
  const ACTOR_ID = '01910000-0000-7000-8000-000000000099';

  const baseHold: {
    id: string;
    bookingId: string;
    paymentIntentId: string;
    clientId: string;
    artistId: string;
    amountCents: bigint;
    platformFeeCents: bigint;
    currency: 'ZAR';
    state: EscrowState;
    partiallyRefundedAmountCents: bigint;
    heldAt: Date;
    releasedAt: Date | null;
    refundedAt: Date | null;
    disputedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  } = {
    id: HOLD_ID,
    bookingId: '01910000-0000-7000-8000-000000000010',
    paymentIntentId: INTENT_ID,
    clientId: '01910000-0000-7000-8000-000000000020',
    artistId: '01910000-0000-7000-8000-000000000030',
    amountCents: 200_000n,
    platformFeeCents: 25_200n,
    currency: 'ZAR',
    state: EscrowState.HELD,
    partiallyRefundedAmountCents: 0n,
    heldAt: new Date(),
    releasedAt: null,
    refundedAt: null,
    disputedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const baseCharge = {
    id: CHARGE_TXN_ID,
    paymentIntentId: INTENT_ID,
    type: TransactionType.CHARGE,
    amountCents: 225_200n,
    currency: 'ZAR',
    gatewayTxnId: PF_PAYMENT_ID,
    pfPaymentStatus: 'COMPLETE',
    state: 'SUCCEEDED',
    rawGatewayPayload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  type RefundRow = {
    id: string;
    transactionId: string;
    amountCents: bigint;
    reason: string | null;
    initiatedBy: string;
    state: RefundState;
    gatewayRefundId: string | null;
    gatewayResponsePayload: unknown;
    failureReason: string | null;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };

  interface FakePrismaConfig {
    hold?: typeof baseHold | null;
    charge?: typeof baseCharge | null;
  }

  interface OutboxRow {
    type: string;
    aggregateId: string;
    data: Record<string, unknown>;
  }

  function buildFakePrisma(cfg: FakePrismaConfig) {
    const refunds: RefundRow[] = [];
    let counter = 1;
    const ctx = {
      escrowHold: {
        findUnique: jest.fn(async () => cfg.hold ?? null),
        findFirst: jest.fn(async () => cfg.hold ?? null),
      },
      transaction: {
        findFirst: jest.fn(async () => cfg.charge ?? null),
        findUnique: jest.fn(async () => cfg.charge ?? null),
      },
      refund: {
        create: jest.fn(async ({ data }: { data: Partial<RefundRow> }) => {
          const row: RefundRow = {
            id: `01910000-0000-7000-8000-${String(counter++).padStart(12, '0')}`,
            transactionId: data.transactionId as string,
            amountCents: data.amountCents as bigint,
            reason: (data.reason as string | null) ?? null,
            initiatedBy: data.initiatedBy as string,
            state: data.state as RefundState,
            gatewayRefundId: null,
            gatewayResponsePayload: null,
            failureReason: null,
            completedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          refunds.push(row);
          return row;
        }),
        update: jest.fn(
          async ({ where, data }: { where: { id: string }; data: Partial<RefundRow> }) => {
            const row = refunds.find((r) => r.id === where.id);
            if (!row) throw new Error(`refund ${where.id} not found in fake`);
            Object.assign(row, data);
            row.updatedAt = new Date();
            return row;
          },
        ),
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
          return refunds.find((r) => r.id === where.id) ?? null;
        }),
      },
    };
    return {
      ctx,
      refunds,
      // Mirror prisma.$transaction(fn) — invoke the work with the same fake
      // client, since our fake has no isolation semantics.
      $transaction: jest.fn(async (fn: (tx: typeof ctx) => Promise<unknown>) => fn(ctx)),
      ...ctx,
    };
  }

  function buildFakeOutbox(): { service: { enqueue: jest.Mock }; rows: OutboxRow[] } {
    const rows: OutboxRow[] = [];
    return {
      service: {
        enqueue: jest.fn(async (_tx: unknown, input: OutboxRow) => {
          rows.push({ type: input.type, aggregateId: input.aggregateId, data: input.data });
          return 'outbox-id';
        }),
      },
      rows,
    };
  }

  function buildSuccess(refundId = 'pf-refund-1'): PayFastRefundSuccess {
    return { ok: true, refundId, rawResponse: { refund_id: refundId } };
  }
  function build5xx(): PayFastRefundFailure {
    return {
      ok: false,
      retriable: true,
      status: 502,
      reason: 'PayFast Bad Gateway',
      rawResponse: { message: 'Bad Gateway' },
    };
  }
  function build4xx(): PayFastRefundFailure {
    return {
      ok: false,
      retriable: false,
      status: 400,
      reason: 'Refund amount exceeds capture',
      rawResponse: { message: 'Refund amount exceeds capture' },
    };
  }

  // ── canRefund ─────────────────────────────────────────────────────────

  describe('canRefund', () => {
    it('HELD hold with charge txn → canRefund=true, maxRefundableCents = amount', async () => {
      const prisma = buildFakePrisma({ hold: baseHold, charge: baseCharge });
      const outbox = buildFakeOutbox();
      const svc = new RefundsService(
        prisma as never,
        { refund: jest.fn() } as never,
        { refund: jest.fn(), partialRefund: jest.fn() } as never,
        outbox.service as never,
      );
      const e = await svc.canRefund(HOLD_ID);
      expect(e.canRefund).toBe(true);
      expect(e.maxRefundableCents).toBe(200_000n);
      expect(e.reason).toBeNull();
    });

    it('REFUNDED hold → canRefund=false NOT_REFUNDABLE_TERMINAL', async () => {
      const prisma = buildFakePrisma({
        hold: { ...baseHold, state: EscrowState.REFUNDED },
        charge: baseCharge,
      });
      const outbox = buildFakeOutbox();
      const svc = new RefundsService(
        prisma as never,
        { refund: jest.fn() } as never,
        { refund: jest.fn(), partialRefund: jest.fn() } as never,
        outbox.service as never,
      );
      const e = await svc.canRefund(HOLD_ID);
      expect(e.canRefund).toBe(false);
      expect(e.reason).toBe('NOT_REFUNDABLE_TERMINAL');
    });

    it('PARTIALLY_REFUNDED with running == amount → NOT_REFUNDABLE_FULLY_REFUNDED', async () => {
      const prisma = buildFakePrisma({
        hold: {
          ...baseHold,
          state: EscrowState.PARTIALLY_REFUNDED,
          partiallyRefundedAmountCents: 200_000n,
        },
        charge: baseCharge,
      });
      const outbox = buildFakeOutbox();
      const svc = new RefundsService(
        prisma as never,
        { refund: jest.fn() } as never,
        { refund: jest.fn(), partialRefund: jest.fn() } as never,
        outbox.service as never,
      );
      const e = await svc.canRefund(HOLD_ID);
      expect(e.canRefund).toBe(false);
      expect(e.reason).toBe('NOT_REFUNDABLE_FULLY_REFUNDED');
    });

    it('PARTIALLY_REFUNDED with running < amount → canRefund=true, max = remaining', async () => {
      const prisma = buildFakePrisma({
        hold: {
          ...baseHold,
          state: EscrowState.PARTIALLY_REFUNDED,
          partiallyRefundedAmountCents: 50_000n,
        },
        charge: baseCharge,
      });
      const outbox = buildFakeOutbox();
      const svc = new RefundsService(
        prisma as never,
        { refund: jest.fn() } as never,
        { refund: jest.fn(), partialRefund: jest.fn() } as never,
        outbox.service as never,
      );
      const e = await svc.canRefund(HOLD_ID);
      expect(e.canRefund).toBe(true);
      expect(e.maxRefundableCents).toBe(150_000n);
    });

    it('missing hold → NOT_REFUNDABLE_HOLD_NOT_FOUND', async () => {
      const prisma = buildFakePrisma({ hold: null, charge: null });
      const outbox = buildFakeOutbox();
      const svc = new RefundsService(
        prisma as never,
        { refund: jest.fn() } as never,
        { refund: jest.fn(), partialRefund: jest.fn() } as never,
        outbox.service as never,
      );
      const e = await svc.canRefund(HOLD_ID);
      expect(e.canRefund).toBe(false);
      expect(e.reason).toBe('NOT_REFUNDABLE_HOLD_NOT_FOUND');
    });
  });

  // ── issueRefund: validation pre-flight ────────────────────────────────

  describe('issueRefund — validation', () => {
    it('refund > remaining → 422 REFUND_EXCEEDS_CAPTURE', async () => {
      const prisma = buildFakePrisma({ hold: baseHold, charge: baseCharge });
      const outbox = buildFakeOutbox();
      const payfastRefund = jest.fn();
      const svc = new RefundsService(
        prisma as never,
        { refund: payfastRefund } as never,
        { refund: jest.fn(), partialRefund: jest.fn() } as never,
        outbox.service as never,
      );
      try {
        await svc.issueRefund({
          holdId: HOLD_ID,
          refundCents: 300_000n,
          reason: 'over',
          faultParty: 'CLIENT',
          actorId: ACTOR_ID,
        });
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).code).toBe(ErrorCode.REFUND_EXCEEDS_CAPTURE);
      }
      expect(payfastRefund).not.toHaveBeenCalled();
    });

    it('terminal hold (REFUNDED) → 409 ILLEGAL_TRANSITION', async () => {
      const prisma = buildFakePrisma({
        hold: { ...baseHold, state: EscrowState.REFUNDED },
        charge: baseCharge,
      });
      const outbox = buildFakeOutbox();
      const payfastRefund = jest.fn();
      const svc = new RefundsService(
        prisma as never,
        { refund: payfastRefund } as never,
        { refund: jest.fn(), partialRefund: jest.fn() } as never,
        outbox.service as never,
      );
      try {
        await svc.issueRefund({
          holdId: HOLD_ID,
          full: true,
          reason: 'late',
          faultParty: 'CLIENT',
          actorId: ACTOR_ID,
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AppException).code).toBe(ErrorCode.ILLEGAL_TRANSITION);
      }
      expect(payfastRefund).not.toHaveBeenCalled();
    });

    it('hold not found → 404 NOT_FOUND', async () => {
      const prisma = buildFakePrisma({ hold: null, charge: null });
      const outbox = buildFakeOutbox();
      const svc = new RefundsService(
        prisma as never,
        { refund: jest.fn() } as never,
        { refund: jest.fn(), partialRefund: jest.fn() } as never,
        outbox.service as never,
      );
      try {
        await svc.issueRefund({
          holdId: HOLD_ID,
          full: true,
          reason: 'x',
          faultParty: 'CLIENT',
          actorId: ACTOR_ID,
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AppException).code).toBe(ErrorCode.NOT_FOUND);
      }
    });
  });

  // ── PayFast retry policy ──────────────────────────────────────────────

  describe('PayFast retry policy', () => {
    it('5xx twice then success: 3 attempts, refunds row SUCCEEDED, escrow.refund called, refund.succeeded outbox', async () => {
      const prisma = buildFakePrisma({ hold: baseHold, charge: baseCharge });
      const outbox = buildFakeOutbox();
      const escrowRefund = jest.fn(async () => ({ ...baseHold, state: EscrowState.REFUNDED }));
      const escrowPartialRefund = jest.fn();

      const payfastRefund = jest
        .fn<Promise<PayFastRefundResult>, []>()
        .mockResolvedValueOnce(build5xx())
        .mockResolvedValueOnce(build5xx())
        .mockResolvedValueOnce(buildSuccess('pf-refund-OK'));

      const svc = new RefundsService(
        prisma as never,
        { refund: payfastRefund } as never,
        { refund: escrowRefund, partialRefund: escrowPartialRefund } as never,
        outbox.service as never,
      );

      const result = await svc.issueRefund({
        holdId: HOLD_ID,
        full: true,
        reason: 'no-show',
        faultParty: 'ARTIST',
        actorId: ACTOR_ID,
      });

      expect(payfastRefund).toHaveBeenCalledTimes(3);
      expect(result.state).toBe(RefundState.SUCCEEDED);
      expect(result.gatewayRefundId).toBe('pf-refund-OK');
      expect(escrowRefund).toHaveBeenCalledTimes(1);
      expect(escrowPartialRefund).not.toHaveBeenCalled();
      // refundId threaded onto the EscrowService call → escrow_events.refund_id
      // (the contract this unit asserts; the actual column write is covered by
      // the e2e spec running against real Postgres).
      const firstCall = escrowRefund.mock.calls[0] as unknown as unknown[];
      const escrowOpts = firstCall[1] as { refundId?: string } | undefined;
      expect(escrowOpts?.refundId).toBe(result.id);
      // Outbox: only payments.refund.succeeded from THIS service (escrow.refunded
      // is emitted by the mocked EscrowService — not exercised here).
      expect(outbox.rows.map((r) => r.type)).toEqual(['payments.refund.succeeded']);
      expect(outbox.rows[0].data.faultParty).toBe('ARTIST');
    });

    it('4xx once: no retry, refunds row FAILED, NO escrow mutation, refund.failed outbox, 502 thrown', async () => {
      const prisma = buildFakePrisma({ hold: baseHold, charge: baseCharge });
      const outbox = buildFakeOutbox();
      const escrowRefund = jest.fn();
      const escrowPartialRefund = jest.fn();

      const payfastRefund = jest
        .fn<Promise<PayFastRefundResult>, []>()
        .mockResolvedValueOnce(build4xx());

      const svc = new RefundsService(
        prisma as never,
        { refund: payfastRefund } as never,
        { refund: escrowRefund, partialRefund: escrowPartialRefund } as never,
        outbox.service as never,
      );

      let thrown: unknown;
      try {
        await svc.issueRefund({
          holdId: HOLD_ID,
          full: true,
          reason: 'rejected',
          faultParty: 'CLIENT',
          actorId: ACTOR_ID,
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(AppException);
      expect((thrown as AppException).code).toBe(ErrorCode.PAYFAST_UPSTREAM_FAILURE);
      expect(payfastRefund).toHaveBeenCalledTimes(1); // no retry on 4xx
      expect(escrowRefund).not.toHaveBeenCalled();
      expect(escrowPartialRefund).not.toHaveBeenCalled();

      // refunds row was written and then updated to FAILED.
      expect(prisma.refunds).toHaveLength(1);
      expect(prisma.refunds[0].state).toBe(RefundState.FAILED);
      expect(prisma.refunds[0].failureReason).toContain('Refund amount exceeds capture');

      // Outbox: payments.refund.failed only.
      expect(outbox.rows.map((r) => r.type)).toEqual(['payments.refund.failed']);
    });

    it('5xx three times: exhausted retries → FAILED + 502', async () => {
      const prisma = buildFakePrisma({ hold: baseHold, charge: baseCharge });
      const outbox = buildFakeOutbox();

      const payfastRefund = jest
        .fn<Promise<PayFastRefundResult>, []>()
        .mockResolvedValue(build5xx());

      const svc = new RefundsService(
        prisma as never,
        { refund: payfastRefund } as never,
        { refund: jest.fn(), partialRefund: jest.fn() } as never,
        outbox.service as never,
      );

      let thrown: unknown;
      try {
        await svc.issueRefund({
          holdId: HOLD_ID,
          full: true,
          reason: 'always-fails',
          faultParty: 'CLIENT',
          actorId: ACTOR_ID,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AppException);
      expect((thrown as AppException).code).toBe(ErrorCode.PAYFAST_UPSTREAM_FAILURE);
      expect(payfastRefund).toHaveBeenCalledTimes(3);
      expect(prisma.refunds[0].state).toBe(RefundState.FAILED);
      expect(outbox.rows.map((r) => r.type)).toEqual(['payments.refund.failed']);
    });
  });

  // ── Partial refund routing ────────────────────────────────────────────

  describe('partial vs full routing to EscrowService', () => {
    it('refundCents < remaining → EscrowService.partialRefund is called, NOT refund', async () => {
      const prisma = buildFakePrisma({ hold: baseHold, charge: baseCharge });
      const outbox = buildFakeOutbox();
      const escrowRefund = jest.fn();
      const escrowPartialRefund = jest.fn(async () => ({
        ...baseHold,
        state: EscrowState.PARTIALLY_REFUNDED,
        partiallyRefundedAmountCents: 50_000n,
      }));

      const payfastRefund = jest
        .fn<Promise<PayFastRefundResult>, []>()
        .mockResolvedValueOnce(buildSuccess('pf-partial'));

      const svc = new RefundsService(
        prisma as never,
        { refund: payfastRefund } as never,
        { refund: escrowRefund, partialRefund: escrowPartialRefund } as never,
        outbox.service as never,
      );

      await svc.issueRefund({
        holdId: HOLD_ID,
        refundCents: 50_000n,
        reason: 'partial',
        faultParty: 'CLIENT',
        actorId: ACTOR_ID,
      });

      expect(escrowPartialRefund).toHaveBeenCalledTimes(1);
      expect(escrowRefund).not.toHaveBeenCalled();
      const partialCall = escrowPartialRefund.mock.calls[0] as unknown as unknown[];
      const opts = partialCall[2] as { refundId?: string } | undefined;
      expect(opts?.refundId).toBeDefined();
    });
  });
});
