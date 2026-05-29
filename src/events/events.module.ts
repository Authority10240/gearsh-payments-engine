import { Global, Module } from '@nestjs/common';
import { EscrowModule } from '../modules/escrow/escrow.module';
import { RefundsModule } from '../modules/refunds/refunds.module';
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
 * PAY-006: handlers are now concrete and call EscrowService + RefundsService.
 * Those services live in EscrowModule + RefundsModule respectively and are
 * imported here so the handlers can resolve them via constructor DI. Both
 * service modules consume OutboxService from this (@Global) EventsModule,
 * which Nest resolves at instantiation time without needing forwardRef
 * because the static import graph is one-directional (this module → them).
 */
@Global()
@Module({
  imports: [EscrowModule, RefundsModule],
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
