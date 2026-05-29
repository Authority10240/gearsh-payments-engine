// PAY-006: real implementation lands with the escrow-driven release / refund /
// freeze flow. For PAY-001 this handler logs + acks so the subscriber pipeline
// is wired end-to-end and processed_events dedup is exercised.
import { Injectable, Logger } from '@nestjs/common';
import type { CloudEvent } from '../../cloud-event';
import type { EventHandler } from '../event-handler';
import { validateEventPayload } from '../payload-schemas';

@Injectable()
export class BookingEventsHandler implements EventHandler {
  private readonly logger = new Logger(BookingEventsHandler.name);
  readonly consumerName = 'payments-escrow-booking';

  handles(eventType: string): boolean {
    return (
      eventType === 'bookings.completed' ||
      eventType === 'bookings.cancelled' ||
      eventType === 'bookings.disputed'
    );
  }

  async handle(event: CloudEvent): Promise<void> {
    // Validate required fields per contracts/events/schemas/<type>.json so an
    // upstream contract drift surfaces as a DLT entry (events/README §5).
    validateEventPayload(event);
    this.logger.log(
      `[PAY-006 STUB] received ${event.type} for ${event.subject} (id=${event.id}); release/refund/freeze deferred`,
    );
  }
}
