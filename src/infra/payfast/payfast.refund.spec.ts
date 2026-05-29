import { PayFastClient } from './payfast.client';

/**
 * PayFastClient.refund — discriminated-result behavior (PAY-004).
 *
 * The RefundsService retry policy depends on:
 *   - degrade-on-missing-creds: returns ok=false retriable=false (no throw)
 *     so issueRefund can persist the FAILED refund row without an exception
 *     short-circuiting the gateway-failure path.
 *   - 5xx / network → retriable=true so the service backs off + retries.
 *   - 4xx → retriable=false so the service stops immediately.
 *
 * The signed-body shape + URL templating are covered by the e2e webhook spec
 * (PAY-002 fixture path); here we only assert the result-mapping contract.
 */
describe('PayFastClient.refund — result mapping', () => {
  function buildClient(overrides: { enabled?: boolean; refundUrl?: string } = {}): PayFastClient {
    const config = {
      payfast: {
        merchantId: 'M-1',
        merchantKey: 'K-1',
        passphrase: 'pf-passphrase',
        sandbox: true,
        processUrl: 'https://sandbox.payfast.co.za/eng/process',
        validateUrl: 'https://sandbox.payfast.co.za/eng/query/validate',
        returnUrl: 'https://return',
        cancelUrl: 'https://cancel',
        notifyUrl: 'https://notify',
        refundUrl: overrides.refundUrl ?? 'https://api.payfast.co.za/refunds/{pf_payment_id}',
        adhocPaymentUrl: 'https://api.payfast.co.za/transactions/adhoc',
        ipWhitelist: [],
        enabled: overrides.enabled ?? true,
      },
    };
    return new PayFastClient(config as never);
  }

  it('degrade-on-missing-creds → ok=false retriable=false (no throw)', async () => {
    const client = buildClient({ enabled: false });
    const result = await client.refund({
      pfPaymentId: 'pf-1',
      amountCents: 100_00n,
      reason: 'test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retriable).toBe(false);
      expect(result.reason).toMatch(/credentials are not configured/i);
    }
  });

  it('missing PAYFAST_REFUND_URL → ok=false retriable=false', async () => {
    // enabled=true (other creds set) but refundUrl explicitly blank.
    const client = buildClient({ refundUrl: '' });
    const result = await client.refund({
      pfPaymentId: 'pf-1',
      amountCents: 100_00n,
      reason: 'test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retriable).toBe(false);
      expect(result.reason).toMatch(/PAYFAST_REFUND_URL/);
    }
  });

  it('4xx response → ok=false retriable=false (RefundsService MUST NOT retry)', async () => {
    const client = buildClient();
    // Stub the internal axios instance to reject with a fake 4xx response.
    // We do this via Object.defineProperty on the private `http` field since
    // it's the simplest path; the unit spec is asserting result mapping, not
    // axios mechanics.
    const fakeError = Object.assign(new Error('400 Bad Request'), {
      isAxiosError: true,
      response: { status: 400, data: { message: 'Refund amount exceeds capture' } },
      code: undefined,
    });
    (client as unknown as { http: { post: jest.Mock } }).http = {
      post: jest.fn().mockRejectedValue(fakeError),
    };

    const result = await client.refund({
      pfPaymentId: 'pf-1',
      amountCents: 100_00n,
      reason: 'test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retriable).toBe(false);
      expect(result.status).toBe(400);
      expect(result.reason).toBe('Refund amount exceeds capture');
    }
  });

  it('5xx response → ok=false retriable=true (caller will back off + retry)', async () => {
    const client = buildClient();
    const fakeError = Object.assign(new Error('502 Bad Gateway'), {
      isAxiosError: true,
      response: { status: 502, data: { message: 'Bad Gateway' } },
      code: undefined,
    });
    (client as unknown as { http: { post: jest.Mock } }).http = {
      post: jest.fn().mockRejectedValue(fakeError),
    };

    const result = await client.refund({
      pfPaymentId: 'pf-1',
      amountCents: 100_00n,
      reason: 'test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retriable).toBe(true);
      expect(result.status).toBe(502);
    }
  });

  it('network error (no response) → ok=false retriable=true', async () => {
    const client = buildClient();
    const fakeError = Object.assign(new Error('ECONNRESET'), {
      isAxiosError: true,
      response: undefined,
      code: 'ECONNRESET',
    });
    (client as unknown as { http: { post: jest.Mock } }).http = {
      post: jest.fn().mockRejectedValue(fakeError),
    };

    const result = await client.refund({
      pfPaymentId: 'pf-1',
      amountCents: 100_00n,
      reason: 'test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retriable).toBe(true);
    }
  });

  it('200 with refund_id → ok=true', async () => {
    const client = buildClient();
    (client as unknown as { http: { post: jest.Mock } }).http = {
      post: jest.fn().mockResolvedValue({ status: 200, data: { refund_id: 'pf-refund-OK' } }),
    };

    const result = await client.refund({
      pfPaymentId: 'pf-1',
      amountCents: 100_00n,
      reason: 'test',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.refundId).toBe('pf-refund-OK');
    }
  });

  it('200 without refund_id → ok=false retriable=false (malformed success — no value in retrying)', async () => {
    const client = buildClient();
    (client as unknown as { http: { post: jest.Mock } }).http = {
      post: jest.fn().mockResolvedValue({ status: 200, data: {} }),
    };

    const result = await client.refund({
      pfPaymentId: 'pf-1',
      amountCents: 100_00n,
      reason: 'test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retriable).toBe(false);
    }
  });
});
