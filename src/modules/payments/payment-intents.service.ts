import { Inject, Injectable } from '@nestjs/common';
import { Currency, IntentState, type PaymentIntent, Prisma } from '@prisma/client';
import { APP_CONFIG } from '../../config/app-config.token';
import type { AppConfig } from '../../config/configuration';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';
import { centsToMajorString } from '../../infra/payfast/forms';
import { PayFastClient } from '../../infra/payfast/payfast.client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { FxService, roundHalfToEven } from '../fx/fx.service';
import type { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';
import type { LockPaymentIntentResponse, PaymentIntentView } from './dto/payment-intent.view';

/**
 * Payment-intents service. Owns the CREATE → LOCK → (PayFast → ITN) lifecycle
 * for the client's currency-in / ZAR-out path (business-rules §8.6).
 *
 *   CREATE: persists the intent in the client's currency; computes
 *           quoted_zar_amount_cents via FxService.convertCurrency.
 *   LOCK:   re-reads the latest FX rate, persists the locked ZAR amount +
 *           rate + timestamps, sets lock_expires_at = now + FX_INTENT_LOCK_TTL,
 *           transitions CREATED → LOCKED, returns the signed PayFast form.
 *   GET:    detail view (internal or owner).
 *
 * The ITN webhook (PAY-002) is responsible for SUCCEEDED/FAILED + the atomic
 * escrow.held side-effect; this service does not run that path.
 */
@Injectable()
export class PaymentIntentsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly fx: FxService,
    private readonly payfast: PayFastClient,
  ) {}

  /** Internal-service call (Data → Payments on booking create). */
  async create(input: CreatePaymentIntentDto): Promise<PaymentIntentView> {
    const subtotal = BigInt(input.subtotalCents);
    const fee =
      input.serviceFeeCents !== undefined
        ? BigInt(input.serviceFeeCents)
        : this.deriveServiceFee(subtotal);
    const total = BigInt(input.totalCents);

    if (subtotal + fee !== total) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, {
        detail: 'totalCents must equal subtotalCents + serviceFeeCents.',
      });
    }

    const clientCurrency: Currency = input.clientCurrency ?? input.currency;

    // Pre-check (race-tolerant: the unique index is the source of truth).
    const existing = await this.prisma.paymentIntent.findUnique({
      where: { bookingId: input.bookingId },
    });
    if (existing) {
      throw new AppException(ErrorCode.PAYMENT_INTENT_EXISTS_FOR_BOOKING, {
        detail: `A payment intent already exists for booking ${input.bookingId}.`,
      });
    }

    // FX quote at intent creation (business-rules §8.6 step 1). Native ZAR
    // intents trivially get amount == quoted_zar_amount_cents.
    const quoted = await this.fx.convertCurrency(total, input.currency, 'ZAR');

    try {
      const created = await this.prisma.paymentIntent.create({
        data: {
          bookingId: input.bookingId,
          userId: input.clientId,
          artistId: input.artistId,
          subtotalCents: subtotal,
          serviceFeeCents: fee,
          totalCents: total,
          currency: input.currency,
          clientCurrency,
          quotedZarAmountCents: quoted.amountCents,
          idempotencyKey: input.idempotencyKey,
          state: IntentState.CREATED,
        },
      });
      return this.toView(created);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppException(ErrorCode.PAYMENT_INTENT_EXISTS_FOR_BOOKING, {
          detail: `A payment intent already exists for booking ${input.bookingId}.`,
        });
      }
      throw err;
    }
  }

  /** Client-facing /lock. Re-reads FX, persists lock, returns PayFast form. */
  async lock(
    intentId: string,
    callerUserId: string,
    callerRoles: string[],
  ): Promise<LockPaymentIntentResponse> {
    const intent = await this.prisma.paymentIntent.findUnique({ where: { id: intentId } });
    if (!intent) throw new AppException(ErrorCode.NOT_FOUND);

    const owner = intent.userId === callerUserId;
    const isAdmin = callerRoles.includes('ADMIN');
    if (!owner && !isAdmin) {
      // Conventions §10: return 404 rather than 403 when the caller has no
      // right to know the resource exists.
      throw new AppException(ErrorCode.NOT_FOUND);
    }

    if (intent.state !== IntentState.CREATED && intent.state !== IntentState.LOCKED) {
      throw new AppException(ErrorCode.ILLEGAL_TRANSITION, {
        detail: `Intent in state ${intent.state} cannot be locked.`,
      });
    }

    // Re-read the latest FX rate at /lock click (business-rules §8.6 step 2).
    const locked = await this.fx.convertCurrency(intent.totalCents, intent.currency, 'ZAR');

    const lockExpiresAt = new Date(
      Date.now() + this.config.business.fxIntentLockTtlMinutes * 60_000,
    );
    const mPaymentId = intent.mPaymentId ?? intent.id;

    const updated = await this.prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        state: IntentState.LOCKED,
        zarAmountCentsLocked: locked.amountCents,
        zarRateLocked: new Prisma.Decimal(locked.rate),
        zarLockedAt: new Date(),
        lockExpiresAt,
        mPaymentId,
      },
    });

    const checkout = this.payfast.buildCheckoutForm({
      returnUrl: this.config.payfast.returnUrl!,
      cancelUrl: this.config.payfast.cancelUrl!,
      notifyUrl: this.config.payfast.notifyUrl!,
      mPaymentId,
      amountMajorUnits: centsToMajorString(locked.amountCents),
      itemName: `Gearsh booking ${intent.bookingId}`,
      itemDescription: `Payment intent ${intent.id}`,
    });

    return {
      id: updated.id,
      state: updated.state,
      payfastRedirectUrl: checkout.redirectUrl,
      formParams: checkout.formParams,
      mPaymentId,
      lockExpiresAt: lockExpiresAt.toISOString(),
    };
  }

  /** Detail view (internal or owner). */
  async getById(
    intentId: string,
    callerUserId: string | null,
    callerRoles: string[],
    isInternal: boolean,
  ): Promise<PaymentIntentView> {
    const intent = await this.prisma.paymentIntent.findUnique({ where: { id: intentId } });
    if (!intent) throw new AppException(ErrorCode.NOT_FOUND);

    if (!isInternal) {
      const owner = callerUserId && intent.userId === callerUserId;
      const isAdmin = callerRoles.includes('ADMIN');
      if (!owner && !isAdmin) {
        throw new AppException(ErrorCode.NOT_FOUND);
      }
    }
    return this.toView(intent);
  }

  private deriveServiceFee(subtotalCents: bigint): bigint {
    const pct = this.config.business.serviceFeePercent;
    const product = new Prisma.Decimal(subtotalCents.toString()).mul(pct).div(100);
    // Half-to-even for the fee derivation too — keeps platform revenue
    // statistically unbiased across many bookings.
    return roundHalfToEven(product);
  }

  private toView(intent: PaymentIntent): PaymentIntentView {
    return {
      id: intent.id,
      bookingId: intent.bookingId,
      state: intent.state,
      currency: intent.currency,
      clientCurrency: intent.clientCurrency,
      subtotalCents: Number(intent.subtotalCents),
      serviceFeeCents: Number(intent.serviceFeeCents),
      totalCents: Number(intent.totalCents),
      quotedZarAmountCents:
        intent.quotedZarAmountCents !== null ? Number(intent.quotedZarAmountCents) : null,
      zarAmountCentsLocked:
        intent.zarAmountCentsLocked !== null ? Number(intent.zarAmountCentsLocked) : null,
      zarRateLocked: intent.zarRateLocked ? intent.zarRateLocked.toString() : null,
      zarLockedAt: intent.zarLockedAt ? intent.zarLockedAt.toISOString() : null,
      lockExpiresAt: intent.lockExpiresAt ? intent.lockExpiresAt.toISOString() : null,
      createdAt: intent.createdAt.toISOString(),
      updatedAt: intent.updatedAt.toISOString(),
    };
  }
}
