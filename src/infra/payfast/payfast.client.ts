import { Inject, Injectable, Logger } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
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

  /** POST /refunds/{pf_payment_id} — fully implemented in PAY-004. Stubbed here
   *  so unit tests can assert the URL/params plumbing. */
  async refund(input: PayFastRefundInput): Promise<{ refundId: string }> {
    this.assertEnabled();
    const url = (this.config.payfast.refundUrl ?? '').replace(
      '{pf_payment_id}',
      encodeURIComponent(input.pfPaymentId),
    );
    if (!url) {
      throw new AppException(ErrorCode.PAYFAST_UPSTREAM_FAILURE, {
        detail: 'PAYFAST_REFUND_URL is not configured.',
      });
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
      return { refundId };
    } catch (err) {
      this.logger.warn(`PayFast refund failed: ${(err as Error).message}`);
      throw new AppException(ErrorCode.PAYFAST_UPSTREAM_FAILURE, {
        detail: 'PayFast refund endpoint failed.',
      });
    }
  }

  /** POST /transactions/adhoc — artist payouts (PAY-005). */
  async adhocPayment(input: PayFastAdhocPaymentInput): Promise<{ payoutId: string }> {
    this.assertEnabled();
    const url = this.config.payfast.adhocPaymentUrl;
    if (!url) {
      throw new AppException(ErrorCode.PAYFAST_UPSTREAM_FAILURE, {
        detail: 'PAYFAST_ADHOC_PAYMENT_URL is not configured.',
      });
    }
    const params: SignableParams = {
      merchant_id: this.config.payfast.merchantId!,
      amount: centsToMajorString(input.amountCents),
      reference: input.reference,
      bank_name: input.bankName,
      branch_code: input.branchCode,
      account_holder: input.accountHolder,
      account_number: input.accountNumber,
      account_type: input.accountType,
      description: input.description,
    };
    const body: SignableParams = {
      ...params,
      signature: signParams(params, this.config.payfast.passphrase),
    };
    try {
      const res = await this.http.post<{ payout_id?: string }>(url, body);
      const payoutId = res.data?.payout_id ?? '';
      return { payoutId };
    } catch (err) {
      this.logger.warn(`PayFast adhoc payment failed: ${(err as Error).message}`);
      throw new AppException(ErrorCode.PAYFAST_UPSTREAM_FAILURE, {
        detail: 'PayFast adhoc-payment endpoint failed.',
      });
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
