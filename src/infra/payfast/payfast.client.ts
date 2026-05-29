import { Inject, Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, type AxiosInstance } from 'axios';
import { APP_CONFIG } from '../../config/app-config.token';
import type { AppConfig } from '../../config/configuration';
import { AppException } from '../../common/problem/app-exception';
import { ErrorCode } from '../../common/problem/error-codes';
import { signParams, verifySignature, type SignableParams } from './signature.util';
import {
  buildPayFastForm,
  centsToMajorString,
  type BuildPayFastFormInput,
  type PayFastFormParams,
} from './forms';

export interface PayFastRefundInput {
  pfPaymentId: string;
  amountCents: bigint;
  reason?: string;
}

/**
 * Discriminated outcome of a PayFast Refund API call (PAY-004). The
 * RefundsService uses `retriable` to decide whether to back off + retry (5xx
 * / timeout / network) or fail terminally (4xx / business rejection). The
 * `rawResponse` is persisted onto refunds.gateway_response_payload regardless
 * of outcome so the nightly reconciliation report (PAY-007) has the full
 * gateway audit trail.
 */
export interface PayFastRefundSuccess {
  ok: true;
  refundId: string;
  rawResponse: unknown;
}

export interface PayFastRefundFailure {
  ok: false;
  /** True when the caller should back off + retry (5xx / network / timeout). */
  retriable: boolean;
  status?: number;
  reason: string;
  rawResponse: unknown;
}

export type PayFastRefundResult = PayFastRefundSuccess | PayFastRefundFailure;

export interface PayFastAdhocPaymentInput {
  /** Artist's verified bank-account details (decrypted in caller). */
  accountHolder: string;
  bankName: string;
  branchCode: string;
  accountNumber: string;
  accountType: string;
  amountCents: bigint;
  reference: string;
  /** Notes echoed back on the payout. */
  description?: string;
}

/**
 * Discriminated outcome of a PayFast Adhoc Payments call (PAY-005). Mirrors
 * the refund-result discrimination from PAY-004 so the dispatcher can:
 *   - decide whether to retry (5xx / network / timeout → retriable=true),
 *   - persist raw_gateway_payload + failure_reason on the payout row even
 *     when the call fails, and
 *   - emit `escrow.payout.failed` with a clean reason rather than a generic
 *     PAYFAST_UPSTREAM_FAILURE.
 */
export interface PayFastAdhocPaymentSuccess {
  ok: true;
  payoutId: string;
  rawResponse: unknown;
}

export interface PayFastAdhocPaymentFailure {
  ok: false;
  /** True when the caller should back off + retry (5xx / network / timeout). */
  retriable: boolean;
  status?: number;
  reason: string;
  rawResponse: unknown;
}

export type PayFastAdhocPaymentResult = PayFastAdhocPaymentSuccess | PayFastAdhocPaymentFailure;

/**
 * Axios-based PayFast client. Implements:
 *   - Hosted-checkout form-param generation (Process URL).
 *   - ITN signature verification.
 *   - Server-to-server ITN validate call (POST /eng/query/validate).
 *   - Refund API call.
 *   - Adhoc Payments API call (artist payouts).
 *
 * Degrade-on-missing-creds: if the config flags PayFast as not enabled (any
 * required env var blank) the methods throw PAYFAST_UPSTREAM_FAILURE — the
 * engine still boots and unrelated endpoints (FX, health, future read
 * endpoints) keep working. This mirrors the data engine's Firebase/Maps stub
 * pattern (business-rules §8.8 / §8.4).
 */
@Injectable()
export class PayFastClient {
  private readonly logger = new Logger(PayFastClient.name);
  private readonly http: AxiosInstance;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.http = axios.create({
      timeout: 15_000,
      headers: { Accept: 'application/json' },
    });
  }

  /** True when ALL PayFast creds + URLs are set; the only-correctness gate. */
  get enabled(): boolean {
    return this.config.payfast.enabled;
  }

  /** Generate signed hosted-checkout form params. */
  buildCheckoutForm(
    input: Omit<BuildPayFastFormInput, 'merchantId' | 'merchantKey' | 'passphrase'>,
  ): {
    formParams: PayFastFormParams;
    redirectUrl: string;
  } {
    this.assertEnabled();
    const { payfast } = this.config;
    const formParams = buildPayFastForm({
      merchantId: payfast.merchantId!,
      merchantKey: payfast.merchantKey!,
      passphrase: payfast.passphrase,
      returnUrl: input.returnUrl ?? payfast.returnUrl!,
      cancelUrl: input.cancelUrl ?? payfast.cancelUrl!,
      notifyUrl: input.notifyUrl ?? payfast.notifyUrl!,
      mPaymentId: input.mPaymentId,
      amountMajorUnits: input.amountMajorUnits,
      itemName: input.itemName,
      itemDescription: input.itemDescription,
      nameFirst: input.nameFirst,
      nameLast: input.nameLast,
      emailAddress: input.emailAddress,
    });
    return { formParams, redirectUrl: payfast.processUrl! };
  }

  /** Re-compute signature over the received ITN params and compare. */
  verifyItnSignature(params: SignableParams, received: string): boolean {
    return verifySignature(params, received, this.config.payfast.passphrase);
  }

  /** Server-to-server ITN validate call. PayFast responds with "VALID" or
   *  "INVALID" on success; anything else means upstream is failing. */
  async validateItn(params: SignableParams): Promise<boolean> {
    this.assertEnabled();
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      body.append(k, String(v));
    }
    try {
      const res = await this.http.post<string>(this.config.payfast.validateUrl!, body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        responseType: 'text',
      });
      const reply = String(res.data ?? '')
        .trim()
        .toUpperCase();
      return reply.startsWith('VALID');
    } catch (err) {
      this.logger.warn(`PayFast validate call failed: ${(err as Error).message}`);
      throw new AppException(ErrorCode.PAYFAST_UPSTREAM_FAILURE, {
        detail: 'PayFast validate endpoint unreachable.',
      });
    }
  }

  /**
   * POST /refunds/{pf_payment_id} — PAY-004 wires the live round-trip. Returns
   * a discriminated PayFastRefundResult rather than throwing so the caller
   * (RefundsService) can:
   *
   *   - decide whether to retry (5xx / network / timeout → retriable=true),
   *   - persist gateway_response_payload + failure_reason on the refund row
   *     even when the call fails, and
   *   - surface a clean 502 to the client only after the retry budget is
   *     exhausted.
   *
   * The {pf_payment_id} placeholder in PAYFAST_REFUND_URL is replaced by the
   * PayFast charge id (transactions.gatewayTxnId). Amounts are submitted in
   * major units per the PayFast spec; centsToMajorString handles the format.
   */
  async refund(input: PayFastRefundInput): Promise<PayFastRefundResult> {
    if (!this.enabled) {
      return {
        ok: false,
        retriable: false,
        reason:
          'PayFast credentials are not configured. Set PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, ' +
          'PAYFAST_PASSPHRASE and PAYFAST_PROCESS_URL via Secret Manager.',
        rawResponse: null,
      };
    }
    const url = (this.config.payfast.refundUrl ?? '').replace(
      '{pf_payment_id}',
      encodeURIComponent(input.pfPaymentId),
    );
    if (!url || !this.config.payfast.refundUrl) {
      return {
        ok: false,
        retriable: false,
        reason: 'PAYFAST_REFUND_URL is not configured.',
        rawResponse: null,
      };
    }
    const params: SignableParams = {
      merchant_id: this.config.payfast.merchantId!,
      amount: centsToMajorString(input.amountCents),
      reason: input.reason,
    };
    const body: SignableParams = {
      ...params,
      signature: signParams(params, this.config.payfast.passphrase),
    };
    try {
      const res = await this.http.post<{ refund_id?: string }>(url, body);
      const refundId = res.data?.refund_id ?? '';
      if (!refundId) {
        // PayFast 200'd but no refund_id — surface as a terminal failure (no
        // value in retrying a malformed 200).
        return {
          ok: false,
          retriable: false,
          status: res.status,
          reason: 'PayFast Refund API returned 200 with no refund_id.',
          rawResponse: res.data ?? null,
        };
      }
      return { ok: true, refundId, rawResponse: res.data ?? null };
    } catch (err) {
      const axiosErr = err as AxiosError<unknown>;
      const status = axiosErr.response?.status;
      const data = axiosErr.response?.data ?? null;
      // Treat 5xx, timeouts, and network errors as retriable; 4xx is terminal
      // (PayFast rejected the refund — retrying won't help).
      const retriable =
        status === undefined ||
        status >= 500 ||
        axiosErr.code === 'ECONNABORTED' ||
        axiosErr.code === 'ETIMEDOUT' ||
        axiosErr.code === 'ECONNRESET';
      this.logger.warn(
        `PayFast refund failed (status=${status ?? 'network'}, retriable=${retriable}): ${(err as Error).message}`,
      );
      return {
        ok: false,
        retriable,
        status,
        reason: extractFailureReason(data, axiosErr),
        rawResponse: data,
      };
    }
  }

  /**
   * POST /transactions/adhoc — artist payouts (PAY-005). Returns a
   * discriminated PayFastAdhocPaymentResult so the dispatcher can implement
   * retries (5xx) vs terminal failures (4xx) without throwing — same shape
   * as `refund()`.
   *
   * Body shape: PayFast Adhoc Payments expects merchant_id, version, amount
   * (major units string), recipient bank details, a unique reference. We
   * sign over the same params then send as application/x-www-form-urlencoded
   * (this matches the PayFast convention for /process and /refunds; the
   * Adhoc endpoint follows the same form-encoded contract).
   */
  async adhocPayment(input: PayFastAdhocPaymentInput): Promise<PayFastAdhocPaymentResult> {
    if (!this.enabled) {
      return {
        ok: false,
        retriable: false,
        reason:
          'PayFast credentials are not configured. Set PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, ' +
          'PAYFAST_PASSPHRASE, PAYFAST_PROCESS_URL and PAYFAST_ADHOC_PAYMENT_URL via Secret Manager.',
        rawResponse: null,
      };
    }
    const url = this.config.payfast.adhocPaymentUrl;
    if (!url) {
      return {
        ok: false,
        retriable: false,
        reason: 'PAYFAST_ADHOC_PAYMENT_URL is not configured.',
        rawResponse: null,
      };
    }
    const params: SignableParams = {
      merchant_id: this.config.payfast.merchantId!,
      version: 'v1',
      amount: centsToMajorString(input.amountCents),
      reference: input.reference,
      bank_name: input.bankName,
      branch_code: input.branchCode,
      account_holder: input.accountHolder,
      account_number: input.accountNumber,
      account_type: input.accountType,
      description: input.description,
    };
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      body.append(k, String(v));
    }
    body.append('signature', signParams(params, this.config.payfast.passphrase));
    try {
      const res = await this.http.post<{ payout_id?: string; reference?: string }>(url, body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      // PayFast returns `payout_id` per the Adhoc Payments contract; fall
      // back to `reference` echo if the API ever swaps the field name.
      const payoutId = res.data?.payout_id ?? res.data?.reference ?? '';
      if (!payoutId) {
        return {
          ok: false,
          retriable: false,
          status: res.status,
          reason: 'PayFast Adhoc Payments returned 200 with no payout_id.',
          rawResponse: res.data ?? null,
        };
      }
      return { ok: true, payoutId, rawResponse: res.data ?? null };
    } catch (err) {
      const axiosErr = err as AxiosError<unknown>;
      const status = axiosErr.response?.status;
      const data = axiosErr.response?.data ?? null;
      const retriable =
        status === undefined ||
        status >= 500 ||
        axiosErr.code === 'ECONNABORTED' ||
        axiosErr.code === 'ETIMEDOUT' ||
        axiosErr.code === 'ECONNRESET';
      this.logger.warn(
        `PayFast adhoc payment failed (status=${status ?? 'network'}, retriable=${retriable}): ${(err as Error).message}`,
      );
      return {
        ok: false,
        retriable,
        status,
        reason: extractFailureReason(data, axiosErr),
        rawResponse: data,
      };
    }
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new AppException(ErrorCode.PAYFAST_UPSTREAM_FAILURE, {
        detail:
          'PayFast credentials are not configured. Set PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, ' +
          'PAYFAST_PASSPHRASE and PAYFAST_PROCESS_URL via Secret Manager.',
      });
    }
  }
}

/** Best-effort extraction of a human-readable failure reason from a PayFast
 *  error response. PayFast returns either JSON `{ message: ... }` or HTML
 *  depending on the gateway path; we fall back to the axios error message. */
function extractFailureReason(data: unknown, err: AxiosError): string {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message.length > 0) return obj.message;
    if (typeof obj.error === 'string' && obj.error.length > 0) return obj.error;
  }
  if (typeof data === 'string' && data.length > 0 && data.length < 500) return data;
  return err.message || 'PayFast refund endpoint failed.';
}
