/** CloudEvents `source` for this engine (events/README §1). */
export const EVENT_SOURCE = 'gearsh-payments-engine';

/**
 * Payments-engine PUBLISHED event types (gearsh-payments-engine.md §Events,
 * contracts/events/topics.md). These are NOT emitted in PAY-001 — full
 * publishers land with PAY-002 (payments.succeeded, payments.failed) and
 * PAY-003 (escrow.* family). Listed here so the multi-topic publisher routes
 * any test fixtures correctly.
 *
 * TODO: replace with @gearsh/contracts once that package is published.
 */
export enum PaymentsEventType {
  // payment-events
  PAYMENTS_INTENT_CREATED = 'payments.intent.created',
  PAYMENTS_SUCCEEDED = 'payments.succeeded',
  PAYMENTS_FAILED = 'payments.failed',
  PAYMENTS_REFUND_SUCCEEDED = 'payments.refund.succeeded',
  PAYMENTS_REFUND_FAILED = 'payments.refund.failed',
  // escrow-events
  ESCROW_HELD = 'escrow.held',
  ESCROW_RELEASED = 'escrow.released',
  ESCROW_REFUNDED = 'escrow.refunded',
  ESCROW_PARTIALLY_REFUNDED = 'escrow.partially_refunded',
  ESCROW_FROZEN = 'escrow.frozen',
  ESCROW_PAYOUT_QUEUED = 'escrow.payout.queued',
  ESCROW_PAYOUT_SUCCEEDED = 'escrow.payout.succeeded',
  ESCROW_PAYOUT_FAILED = 'escrow.payout.failed',
}

/**
 * Maps a published event type to its Pub/Sub topic (contracts/events/topics.md
 * §Topic matrix). Payments publishes to two topics; this list is consulted by
 * the multi-topic publisher (mirrors the data-engine pattern).
 */
const EVENT_TOPIC_PREFIX: Array<{ prefix: string; topic: string }> = [
  { prefix: 'payments.', topic: 'payment-events' },
  { prefix: 'escrow.', topic: 'escrow-events' },
];

export function topicForEventType(eventType: string): string | undefined {
  return EVENT_TOPIC_PREFIX.find((m) => eventType.startsWith(m.prefix))?.topic;
}

/** Schema version per event type (echoed in the envelope `dataschema`). */
export const EVENT_SCHEMA_VERSION = '1.0.0';

export function dataSchemaUri(type: string): string {
  return `https://contracts.thegearsh.app/events/${type}/${EVENT_SCHEMA_VERSION}`;
}
