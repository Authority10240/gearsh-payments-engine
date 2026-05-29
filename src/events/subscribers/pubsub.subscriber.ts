import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { PubSub, type Message, type Subscription } from '@google-cloud/pubsub';
import { APP_CONFIG } from '../../config/app-config.token';
import type { AppConfig } from '../../config/configuration';
import type { CloudEvent } from '../cloud-event';
import { EVENT_HANDLERS, type EventHandler } from './event-handler';
import { ProcessedEventsService } from './processed-events.service';

const REQUIRED_ENVELOPE_FIELDS: Array<keyof CloudEvent> = [
  'specversion',
  'id',
  'type',
  'source',
  'subject',
  'datacontenttype',
  'data',
];

/**
 * Pub/Sub subscriber infrastructure (events/README §2, §5; mirrors data
 * engine). The Payments Engine subscribes to:
 *   payments-sub-booking-events  (RELEASE / REFUND / FREEZE)
 *   payments-sub-dispute-events  (RESOLVE)
 *
 * Per message it:
 *   1. parses + validates the CloudEvents 1.0 envelope (NACK on invalid → DLT),
 *   2. dedups via processed_events (insert-or-skip),
 *   3. routes to the registered handler(s) by event type,
 *   4. ACKs on success / unknown type (so new types don't poison the sub),
 *      NACKs on handler error (redeliver → DLT after max attempts).
 */
@Injectable()
export class PubSubSubscriber implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PubSubSubscriber.name);
  private client?: PubSub;
  private readonly subscriptions: Subscription[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly processed: ProcessedEventsService,
    @Inject(EVENT_HANDLERS) private readonly handlers: EventHandler[],
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.pubsub.enabled) {
      this.logger.log('Pub/Sub disabled — subscribers not started');
      return;
    }
    if (this.config.pubsub.subscriptions.length === 0) {
      this.logger.warn('No PUBSUB_SUBSCRIPTIONS configured — nothing to consume');
      return;
    }

    this.client = new PubSub({ projectId: this.config.pubsub.projectId });
    for (const name of this.config.pubsub.subscriptions) {
      const sub = this.client.subscription(name, { flowControl: { maxMessages: 20 } });
      sub.on('message', (msg) => void this.onMessage(name, msg));
      sub.on('error', (err) => this.logger.error(`Subscription ${name} error: ${err.message}`));
      this.subscriptions.push(sub);
      this.logger.log(`Subscribed to ${name}`);
    }
  }

  private async onMessage(subscriptionName: string, message: Message): Promise<void> {
    const event = this.parseEnvelope(message);
    if (!event) {
      this.logger.warn(`[${subscriptionName}] invalid CloudEvents envelope; nacking ${message.id}`);
      message.nack();
      return;
    }

    const matched = this.handlers.filter((h) => h.handles(event.type));
    if (matched.length === 0) {
      this.logger.debug(`[${subscriptionName}] no handler for ${event.type}; acking ${event.id}`);
      message.ack();
      return;
    }

    try {
      for (const handler of matched) {
        const first = await this.processed.markIfFirst(event.id, handler.consumerName, event.type);
        if (!first) {
          this.logger.debug(`[${handler.consumerName}] duplicate ${event.id}; skipping`);
          continue;
        }
        await handler.handle(event);
      }
      message.ack();
    } catch (err) {
      this.logger.error(
        `[${subscriptionName}] handler failed for ${event.type} (${event.id}): ${(err as Error).message}`,
      );
      message.nack();
    }
  }

  private parseEnvelope(message: Message): CloudEvent | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data.toString('utf8'));
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    for (const field of REQUIRED_ENVELOPE_FIELDS) {
      if (obj[field] === undefined || obj[field] === null) return null;
    }
    if (obj.specversion !== '1.0') return null;
    if (typeof obj.id !== 'string' || typeof obj.type !== 'string') return null;
    return obj as unknown as CloudEvent;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.subscriptions.map((s) => s.close().catch(() => undefined)));
    if (this.client) await this.client.close();
  }
}
