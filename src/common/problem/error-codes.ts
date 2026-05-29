/**
 * Canonical error codes (contracts/errors.md). Cross-engine codes MUST be
 * reused as-is; Payments-Engine-specific codes are domain-prefixed. Each maps
 * to its HTTP status and a stable, human-readable title for the RFC 7807
 * envelope.
 *
 * TODO: replace with @gearsh/contracts once that package is published.
 */
export enum ErrorCode {
  // ── Cross-engine (canonical) ──
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  INVALID_JSON = 'INVALID_JSON',
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  SESSION_REVOKED = 'SESSION_REVOKED',
  FORBIDDEN = 'FORBIDDEN',
  ADMIN_REQUIRED = 'ADMIN_REQUIRED',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  ILLEGAL_TRANSITION = 'ILLEGAL_TRANSITION',
  IDEMPOTENCY_KEY_MISMATCH = 'IDEMPOTENCY_KEY_MISMATCH',
  RESOURCE_GONE = 'RESOURCE_GONE',
  BUSINESS_RULE_VIOLATION = 'BUSINESS_RULE_VIOLATION',
  RATE_LIMITED = 'RATE_LIMITED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  UPSTREAM_FAILURE = 'UPSTREAM_FAILURE',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  UPSTREAM_TIMEOUT = 'UPSTREAM_TIMEOUT',

  // ── Payments Engine (contracts/errors.md §Payments) ──
  CART_EMPTY = 'CART_EMPTY',
  PAYFAST_SIGNATURE_INVALID = 'PAYFAST_SIGNATURE_INVALID',
  PAYFAST_VALIDATION_FAILED = 'PAYFAST_VALIDATION_FAILED',
  PAYFAST_IP_NOT_WHITELISTED = 'PAYFAST_IP_NOT_WHITELISTED',
  PAYMENT_INTENT_EXISTS_FOR_BOOKING = 'PAYMENT_INTENT_EXISTS_FOR_BOOKING',
  ESCROW_ILLEGAL_TRANSITION = 'ESCROW_ILLEGAL_TRANSITION',
  ESCROW_FROZEN = 'ESCROW_FROZEN',
  LEDGER_IMBALANCE = 'LEDGER_IMBALANCE',
  REFUND_EXCEEDS_CAPTURE = 'REFUND_EXCEEDS_CAPTURE',
  CURRENCY_UNSUPPORTED = 'CURRENCY_UNSUPPORTED',
  FX_RATE_UNAVAILABLE = 'FX_RATE_UNAVAILABLE',
  PAYFAST_UPSTREAM_FAILURE = 'PAYFAST_UPSTREAM_FAILURE',
}

export interface ErrorMeta {
  status: number;
  title: string;
}

export const ERROR_META: Record<ErrorCode, ErrorMeta> = {
  [ErrorCode.VALIDATION_FAILED]: { status: 400, title: 'Request validation failed' },
  [ErrorCode.INVALID_JSON]: { status: 400, title: 'Malformed JSON body' },
  [ErrorCode.UNAUTHENTICATED]: { status: 401, title: 'Authentication required' },
  [ErrorCode.TOKEN_EXPIRED]: { status: 401, title: 'Token expired' },
  [ErrorCode.SESSION_REVOKED]: { status: 401, title: 'Session revoked' },
  [ErrorCode.FORBIDDEN]: { status: 403, title: 'Forbidden' },
  [ErrorCode.ADMIN_REQUIRED]: { status: 403, title: 'Administrator role required' },
  [ErrorCode.NOT_FOUND]: { status: 404, title: 'Resource not found' },
  [ErrorCode.CONFLICT]: { status: 409, title: 'Conflict' },
  [ErrorCode.ILLEGAL_TRANSITION]: { status: 409, title: 'Illegal state transition' },
  [ErrorCode.IDEMPOTENCY_KEY_MISMATCH]: { status: 409, title: 'Idempotency key mismatch' },
  [ErrorCode.RESOURCE_GONE]: { status: 410, title: 'Resource gone' },
  [ErrorCode.BUSINESS_RULE_VIOLATION]: { status: 422, title: 'Business rule violation' },
  [ErrorCode.RATE_LIMITED]: { status: 429, title: 'Too many requests' },
  [ErrorCode.INTERNAL_ERROR]: { status: 500, title: 'Internal server error' },
  [ErrorCode.UPSTREAM_FAILURE]: { status: 502, title: 'Upstream dependency failure' },
  [ErrorCode.SERVICE_UNAVAILABLE]: { status: 503, title: 'Service unavailable' },
  [ErrorCode.UPSTREAM_TIMEOUT]: { status: 504, title: 'Upstream dependency timeout' },

  // payments
  [ErrorCode.CART_EMPTY]: { status: 400, title: 'Cart is empty' },
  [ErrorCode.PAYFAST_SIGNATURE_INVALID]: { status: 400, title: 'PayFast signature is invalid' },
  [ErrorCode.PAYFAST_VALIDATION_FAILED]: {
    status: 400,
    title: 'PayFast validate endpoint rejected the payload',
  },
  [ErrorCode.PAYFAST_IP_NOT_WHITELISTED]: {
    status: 403,
    title: 'PayFast webhook source IP not whitelisted',
  },
  [ErrorCode.PAYMENT_INTENT_EXISTS_FOR_BOOKING]: {
    status: 409,
    title: 'A payment intent already exists for this booking',
  },
  [ErrorCode.ESCROW_ILLEGAL_TRANSITION]: {
    status: 409,
    title: 'Illegal escrow state transition',
  },
  [ErrorCode.ESCROW_FROZEN]: { status: 409, title: 'Escrow hold is frozen by an active dispute' },
  [ErrorCode.LEDGER_IMBALANCE]: { status: 409, title: 'Ledger entries are not balanced' },
  [ErrorCode.REFUND_EXCEEDS_CAPTURE]: {
    status: 422,
    title: 'Refund amount exceeds captured amount',
  },
  [ErrorCode.CURRENCY_UNSUPPORTED]: { status: 422, title: 'Currency is not supported' },
  [ErrorCode.FX_RATE_UNAVAILABLE]: { status: 422, title: 'No exchange rate available' },
  [ErrorCode.PAYFAST_UPSTREAM_FAILURE]: { status: 502, title: 'PayFast upstream failure' },
};

/** Non-dereferenceable problem `type` URI (conventions §7). */
export function problemType(code: ErrorCode): string {
  const slug = code.toLowerCase().replace(/_/g, '-');
  return `https://errors.thegearsh.app/payments/${slug}`;
}
