import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../infra/prisma/prisma.service';
import { PubSubPublisher } from './pubsub.publisher';
import type { CloudEvent, OutboxPayload } from './cloud-event';

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 10;

/**
 * Polls the outbox and publishes unsent events to Pub/Sub, then marks them
 * published. At-least-once: a crash after publish but before the mark causes a
 * redelivery, which consumers dedupe on envelope `id` (events/README §2).
 */
@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: PubSubPublisher,
  ) {}

  @Interval('outbox-dispatch', 2000)
  async dispatch(): Promise<void> {
    if (this.running) return; // never overlap ticks
    this.running = true;
    try {
      const batch = await this.prisma.outboxEvent.findMany({
        where: { publishedAt: null, attempts: { lt: MAX_ATTEMPTS } },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      });

      for (const row of batch) {
        const payload = row.payload as unknown as OutboxPayload;
        const envelope: CloudEvent = { ...payload, id: row.id, time: row.createdAt.toISOString() };
        try {
          await this.publisher.publish(envelope);
          await this.prisma.outboxEvent.update({
            where: { id: row.id },
            data: { publishedAt: new Date(), lastError: null },
          });
        } catch (err) {
          const message = (err as Error).message;
          this.logger.warn(`Failed to publish ${row.eventType} (${row.id}): ${message}`);
          await this.prisma.outboxEvent.update({
            where: { id: row.id },
            data: { attempts: { increment: 1 }, lastError: message.slice(0, 1000) },
          });
        }
      }
    } catch (err) {
      this.logger.error(`Outbox dispatch loop error: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
