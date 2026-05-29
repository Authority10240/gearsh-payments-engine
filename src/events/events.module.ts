import { Global, Module } from '@nestjs/common';
import { OutboxDispatcher } from './outbox.dispatcher';
import { OutboxService } from './outbox.service';
import { PubSubPublisher } from './pubsub.publisher';
import { EVENT_HANDLERS, type EventHandler } from './subscribers/event-handler';
import { ProcessedEventsService } from './subscribers/processed-events.service';
import { PubSubSubscriber } from './subscribers/pubsub.subscriber';
import { BookingEventsHandler } from './subscribers/handlers/booking-events.handler';
import { DisputeEventsHandler } from './subscribers/handlers/dispute-events.handler';

/**
 * Publish side (transactional outbox → Pub/Sub) AND subscribe side (Pub/Sub
 * pull → validated, deduped handlers). Payments does both: it publishes
 * payment-events + escrow-events and subscribes to booking-events +
 * dispute-events (contracts/events/topics.md).
 *
 * Handlers are STUBS in PAY-001 (real impl is PAY-006); the wiring exists so
 * the engine boots end-to-end with the bus enabled.
 */
@Global()
@Module({
  providers: [
    // publish
    OutboxService,
    PubSubPublisher,
    OutboxDispatcher,
    // subscribe
    ProcessedEventsService,
    PubSubSubscriber,
    BookingEventsHandler,
    DisputeEventsHandler,
    {
      provide: EVENT_HANDLERS,
      useFactory: (
        booking: BookingEventsHandler,
        dispute: DisputeEventsHandler,
      ): EventHandler[] => [booking, dispute],
      inject: [BookingEventsHandler, DisputeEventsHandler],
    },
  ],
  exports: [OutboxService],
})
export class EventsModule {}
