import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * Consumer-side dedup (events/README §2). A `processed_events` row, unique on
 * (event_id, consumer_name), records that a consumer has handled an event.
 * Insert-or-skip: at-least-once delivery means the same envelope `id` can
 * arrive more than once.
 */
@Injectable()
export class ProcessedEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns true if this is the first time `consumer` sees `eventId`. */
  async markIfFirst(eventId: string, consumer: string, eventType: string): Promise<boolean> {
    try {
      await this.prisma.processedEvent.create({
        data: { eventId, consumerName: consumer, eventType },
      });
      return true;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' // unique violation → already processed
      ) {
        return false;
      }
      throw err;
    }
  }
}
