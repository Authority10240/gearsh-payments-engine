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
 */

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
  // bookings.cancelled.json
  'bookings.cancelled': [
    'bookingId',
    'clientId',
    'artistId',
    'cancelledAt',
    'cancelledBy',
    'refundPolicy',
  ],
  // bookings.disputed.json
  'bookings.disputed': ['bookingId', 'clientId', 'artistId', 'disputeId', 'openedAt', 'openedBy'],
  // disputes.resolved.json — outcome drives release-or-refund (business rules §6, §8.5)
  'disputes.resolved': ['disputeId', 'bookingId', 'outcome', 'resolvedAt', 'resolvedBy'],
};

export class EventPayloadValidationError extends Error {}

/**
 * Validate `event.data` against the known required-field list for `event.type`.
 * Unknown types are not validated here (the subscriber acks them as "no handler").
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
}
