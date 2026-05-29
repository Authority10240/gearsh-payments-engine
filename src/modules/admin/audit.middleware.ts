import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** ~10KB cap on the serialised request body, after redaction. */
export const MAX_AUDIT_BODY_BYTES = 10 * 1024;

/**
 * Body keys whose values are replaced with `[REDACTED]` (case-insensitive).
 * Per the PAY-007 spec — drop `accountNumber`, `password`, `token`,
 * `idempotencyKey` keys recursively. We also include the cross-engine
 * staples (signature, passphrase, accessToken, etc.) so the middleware's
 * safe-by-default surface is wider than the explicit list.
 */
const SENSITIVE_BODY_KEYS = new Set<string>([
  'accountnumber',
  'password',
  'newpassword',
  'currentpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'fcmtoken',
  'idempotencykey',
  'signature',
  'signaturedata',
  'passphrase',
  'authorization',
]);

/** ≥ 8 consecutive digits anywhere in a string → likely card / account number. */
const NUMERIC_MASK_RE = /\d{8,}/g;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Audit middleware for `/v1/admin/*` (conventions §10, PAY-007). Mounted in
 * AppModule.configure() AFTER the global RequestContextMiddleware so the
 * requestId/traceparent already exist on `req`. The middleware writes ONE row
 * per admin response into `admin_audit_log`:
 *
 *   - actorId      = JWT `sub` (null when the request short-circuited before
 *                    the JwtAuthGuard could attach a user — e.g. invalid
 *                    token; that path returns 401 and is NOT audited).
 *   - action       = either the explicit `AuditAction` metadata (preferred)
 *                    or "<METHOD> <route-template>" fallback.
 *   - path         = `req.originalUrl` minus any query string.
 *   - method       = HTTP method.
 *   - targetId     = the `:id` param (or first uuid-looking) when present.
 *   - requestBody  = redacted + truncated copy of the JSON body.
 *   - responseCode = response status.
 *   - ip / userAgent from the request.
 *
 * **Write timing:** the write is fired-and-forgotten via `setImmediate` AFTER
 * `res.on('finish')` so the audited request never waits on the audit row. A
 * persistence failure is logged at warn level and otherwise swallowed — the
 * admin response must not be blocked by an audit-log outage.
 *
 * **Authorisation short-circuits:** when the AdminGuard throws ADMIN_REQUIRED
 * (403) we still want a record of the rejected attempt — the JwtAuthGuard
 * runs first (globally), so `req.user` is attached BEFORE the AdminGuard
 * decides. A request that died at the JWT guard (401, no `req.user`) is NOT
 * written: there is no actor to attribute it to.
 */
@Injectable()
export class AdminAuditMiddleware implements NestMiddleware {
  private static readonly logger = new Logger(AdminAuditMiddleware.name);

  constructor(private readonly prisma: PrismaService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = Date.now();

    res.on('finish', () => {
      const user = (req as Request & { user?: { sub?: string } }).user;
      if (!user || !user.sub) return; // unauthenticated — no actor to record

      // The AuditActionInterceptor stamps `req.auditAction` from the handler's
      // `@AuditAction(...)` metadata so the middleware can use it without
      // doing its own Reflector dance (middlewares run before route matching,
      // so they don't have ergonomic handler access).
      const action = resolveAction(req);
      const path = stripQuery(req.originalUrl ?? req.url ?? '');
      const targetId = extractTargetId(req);
      const requestBody = redactBody((req as Request & { body?: unknown }).body);
      const ip = (req.ip ?? req.socket?.remoteAddress ?? null) || null;
      const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;

      setImmediate(() => {
        this.prisma.adminAuditLog
          .create({
            data: {
              actorId: user.sub,
              action,
              path,
              method: req.method,
              targetId,
              requestBody: requestBody === undefined ? undefined : (requestBody as object),
              responseCode: res.statusCode,
              ip,
              userAgent,
            },
          })
          .catch((err) => {
            AdminAuditMiddleware.logger.warn(
              `audit write failed for ${req.method} ${path} after ${Date.now() - startedAt}ms: ${
                (err as Error).message
              }`,
            );
          });
      });
    });

    next();
  }
}

/** Strip the query string for the stored `path` (audit row keeps it terse). */
function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Resolve the audit action string. Priority order:
 *   1. `req.auditAction` — set by AuditActionInterceptor from the handler's
 *      `@AuditAction('payments.holds.release')` metadata.
 *   2. `req.route.path` template ("/v1/admin/payouts/:id/retry") prefixed by
 *      the method, so distinct uuid path params don't pollute the column.
 *   3. The raw path (fallback when no route matched — i.e. a 404).
 */
function resolveAction(req: Request): string {
  const annotated = (req as Request & { auditAction?: string }).auditAction;
  if (annotated && annotated.length > 0) return annotated;
  const routePath = (req.route as { path?: string } | undefined)?.path;
  const tail = routePath ?? stripQuery(req.originalUrl ?? req.url ?? '');
  return `${req.method} ${tail}`;
}

/** Pick `:id` from Express params, or the first UUID-shaped value. */
function extractTargetId(req: Request): string | null {
  const params = (req.params ?? {}) as Record<string, string | undefined>;
  if (params.id && isUuidish(params.id)) return params.id;
  for (const value of Object.values(params)) {
    if (value && isUuidish(value)) return value;
  }
  return null;
}

function isUuidish(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * Produce a redacted shallow copy of the request body, then truncate. Returns
 * `undefined` when the body is empty (Prisma stores SQL NULL); otherwise the
 * redacted JSON value or a truncated sentinel.
 *
 * Exported for unit tests.
 */
export function redactBody(
  body: unknown,
): Record<string, unknown> | unknown[] | string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'object') {
    const s = String(body);
    const masked = maskNumeric(s);
    return masked.length > MAX_AUDIT_BODY_BYTES ? masked.slice(0, MAX_AUDIT_BODY_BYTES) : masked;
  }
  const out = Array.isArray(body)
    ? body.map((v) => redactValue(v))
    : redactObject(body as Record<string, unknown>);
  const serialised = safeStringify(out);
  if (serialised && serialised.length > MAX_AUDIT_BODY_BYTES) {
    return {
      truncated: true,
      sizeBytes: serialised.length,
      preview: serialised.slice(0, 256),
    };
  }
  return out as Record<string, unknown> | unknown[];
}

function redactObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_BODY_KEYS.has(key.toLowerCase())) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = redactValue(value);
  }
  return out;
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return maskNumeric(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (isPlainObject(value)) return redactObject(value as Record<string, unknown>);
  return value;
}

/**
 * Replace any run of ≥ 8 consecutive digits with `[MASKED]`. The middleware
 * applies this AFTER key-name redaction, so card-shaped values that slipped
 * past the key filter (e.g. a free-form "notes" column) still get masked.
 */
function maskNumeric(value: string): string {
  return value.replace(NUMERIC_MASK_RE, '[MASKED]');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
