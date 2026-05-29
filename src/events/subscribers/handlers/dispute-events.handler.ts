// PAY-006: real implementation lands with the disputes.resolved → release /
// refund / split escrow flow. Stubbed (log + ack) for PAY-001.
import { Injectable, Logger } from '@nestjs/common';
import type { CloudEvent } from '../../cloud-event';
import type { EventHandler } from '../event-handler';
import { validateEventPayload } from '../payload-schemas';

@Injectable()
export class DisputeEventsHandler implements EventHandler {
  private readonly logger = new Logger(DisputeEventsHandler.name);
  readonly consumerName = 'payments-escrow-dispute';

  handles(eventType: string): boolean {
    return eventType === 'disputes.resolved';
  }

  async handle(event: CloudEvent): Promise<void> {
    validateEventPayload(event);
    this.logger.log(
      `[PAY-006 STUB] received ${event.type} for ${event.subject} (id=${event.id}); resolution actions deferred`,
    );
  }
}
