import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key used by the admin audit middleware (PAY-007) to derive the
 * `action` column on the `admin_audit_log` row. When a handler is annotated
 * with `@AuditAction('payments.holds.release')` the middleware writes that
 * string instead of the fallback "<METHOD> <route-template>" form.
 *
 * The middleware never blocks the response on a missing decorator — it falls
 * back to the route template. The decorator exists so the highest-volume
 * admin routes (escrow holds release, refunds POST, payouts retry/cancel) get
 * a stable string in the audit log that survives URL changes.
 */
export const AUDIT_ACTION_KEY = 'admin:audit-action';
export const AuditAction = (action: string) => SetMetadata(AUDIT_ACTION_KEY, action);
