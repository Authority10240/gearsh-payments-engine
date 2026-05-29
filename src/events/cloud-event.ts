/** CloudEvents 1.0 (JSON) envelope (contracts/events/README §1). */
export interface CloudEvent<T = Record<string, unknown>> {
  specversion: '1.0';
  id: string;
  type: string;
  source: string;
  subject: string;
  time: string;
  datacontenttype: 'application/json';
  dataschema: string;
  data: T;
  traceparent: string;
  tracestate: string;
}

/** Stored in outbox_events.payload — the envelope minus id/time (set at publish). */
export type OutboxPayload = Omit<CloudEvent, 'id' | 'time'>;
