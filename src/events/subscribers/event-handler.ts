import type { CloudEvent } from '../cloud-event';

/**
 * A handler consumes one CloudEvent. Implementations MUST be idempotent
 * (events/README §2). Throwing causes a NACK → redelivery → DLT after the
 * subscription's max attempts. Returning normally ACKs the message.
 */
export interface EventHandler {
  /** Stable consumer name, written to processed_events for dedup. */
  readonly consumerName: string;
  /** Event types this handler claims. */
  handles(eventType: string): boolean;
  /** Process the validated envelope. */
  handle(event: CloudEvent): Promise<void>;
}

export const EVENT_HANDLERS = 'EVENT_HANDLERS';
