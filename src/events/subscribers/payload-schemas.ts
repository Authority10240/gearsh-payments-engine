import type { CloudEvent } from '../cloud-event';

/**
 * Lightweight inbound-payload validation (events/README §5: "validate the data
 * against the referenced JSON schema; reject on failure, never best-effort
 * parse"). Same pattern as the data engine; we enforce REQUIRED-field lists
 * transcribed from contracts/events/schemas/*.json for the types the Payments
 * subscribers consume. A missing/empty required field throws, which the
 * subscriber turns into a NACK → DLT.
 *
 * The Payments Engine subscribes to:
 *   - booking-events  → release / refund / freeze (escrow) — PAY-006
 *   - dispute-events  → resolve (release / refund / split) — PAY-006
 *
 * PAY-006 extended these schemas to match what contracts/events/schemas/*.json
 * actually require AND added per-type enum / conditional-required checks
 * (refundPolicy / actorRole / resolution + SPLIT-fields) so contract drift on
 * the Data Engine side surfaces at this boundary as a DLT entry rather than as
 * a runtime exception deep inside an EscrowService transaction.
 */

/** Allowed enum values per field — copied from the contract JSON schemas. */
const REFUND_POLICIES = new Set(['FULL_REFUND', 'PARTIAL_REFUND', 'NO_REFUND']);
const CANCELLATION_ACTOR_ROLES = new Set(['CLIENT', 'ARTIST', 'ADMIN', 'SYSTEM']);
const DISPUTE_ACTOR_ROLES = new Set(['CLIENT', 'ARTIST', 'ADMIN']);
const COMPLETION_REASONS = new Set(['AUTO_COMPLETE', 'MANUAL_ADMIN', 'CLIENT_CONFIRMED']);
const RESOLUTIONS = new Set(['RELEASE_TO_ARTIST', 'REFUND_TO_CLIENT', 'SPLIT']);

/** Required-field lists, copied from contracts/events/schemas/<type>.json. */
const REQUIRED: Record<string, string[]> = {
  // bookings.completed.json
  'bookings.completed': [
    'bookingId',
    'clientId',
    'artistId',
    'serviceId',
    'escrowHoldId',
    'startAt',
    'endAt',
    'totalCents',
    'currency',
    'completedAt',
    'completionReason',
  ],
  // bookings.cancelled.json — escrowHoldId is required by the schema but may
  // be null when the booking was cancelled before payment (DRAFT). The
  // subscriber treats null as "no hold → log + ack" (see handler).
  'bookings.cancelled': [
    'bookingId',
    'clientId',
    'artistId',
    'cancelledBy',
    'actorRole',
    'reason',
    'refundPolicy',
    'cancelledAt',
  ],
  // bookings.disputed.json
  'bookings.disputed': [
    'bookingId',
    'disputeId',
    'escrowHoldId',
    'openedBy',
    'actorRole',
    'subject',
    'openedAt',
  ],
  // disputes.resolved.json — resolution drives release-or-refund-or-split.
  'disputes.resolved': [
    'disputeId',
    'bookingId',
    'escrowHoldId',
    'resolution',
    'resolvedBy',
    'resolvedAt',
  ],
};

export class EventPayloadValidationError extends Error {}

/**
 * Validate `event.data` against the known required-field list for `event.type`,
 * plus the small set of enum / conditional-required rules that PAY-006 actually
 * branches on. Unknown types are not validated here (the subscriber acks them
 * as "no handler").
 */
export function validateEventPayload(event: CloudEvent): void {
  const required = REQUIRED[event.type];
  if (!required) return;
  const data = event.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') {
    throw new EventPayloadValidationError(`${event.type}: data is missing or not an object`);
  }
  const missing = required.filter((field) => data[field] === undefined || data[field] === null);
  if (missing.length > 0) {
    throw new EventPayloadValidationError(
      `${event.type}: missing required field(s): ${missing.join(', ')}`,
    );
  }

  switch (event.type) {
    case 'bookings.completed': {
      assertEnum(event.type, 'completionReason', data.completionReason, COMPLETION_REASONS);
      break;
    }
    case 'bookings.cancelled': {
      assertEnum(event.type, 'refundPolicy', data.refundPolicy, REFUND_POLICIES);
      assertEnum(event.type, 'actorRole', data.actorRole, CANCELLATION_ACTOR_ROLES);
      if (data.refundPolicy === 'PARTIAL_REFUND') {
        const cents = data.partialRefundCents;
        if (typeof cents !== 'number' || !Number.isInteger(cents) || cents <= 0) {
          throw new EventPayloadValidationError(
            `${event.type}: partialRefundCents must be a positive integer when refundPolicy=PARTIAL_REFUND`,
          );
        }
      }
      break;
    }
    case 'bookings.disputed': {
      assertEnum(event.type, 'actorRole', data.actorRole, DISPUTE_ACTOR_ROLES);
      break;
    }
    case 'disputes.resolved': {
      assertEnum(event.type, 'resolution', data.resolution, RESOLUTIONS);
      if (data.resolution === 'SPLIT') {
        for (const field of ['splitArtistCents', 'splitClientCents'] as const) {
          const v = data[field];
          if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
            throw new EventPayloadValidationError(
              `${event.type}: ${field} must be a non-negative integer when resolution=SPLIT`,
            );
          }
        }
      }
      break;
    }
  }
}

function assertEnum(eventType: string, field: string, value: unknown, allowed: Set<string>): void {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new EventPayloadValidationError(
      `${eventType}: ${field} must be one of ${[...allowed].join('|')}, got ${String(value)}`,
    );
  }
}
