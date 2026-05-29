import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PubSub, type Topic } from '@google-cloud/pubsub';
import { APP_CONFIG } from '../config/app-config.token';
import type { AppConfig } from '../config/configuration';
import type { CloudEvent } from './cloud-event';
import { topicForEventType } from './event-types';

/**
 * Multi-topic Pub/Sub publisher (gearsh-payments-engine.md §Events — Payments
 * publishes to payment-events AND escrow-events). The target topic is derived
 * from the event `type` (events/event-types.ts). When Pub/Sub is disabled
 * it logs instead, so the engine runs end-to-end locally without a live bus.
 */
@Injectable()
export class PubSubPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(PubSubPublisher.name);
  private client?: PubSub;
  private readonly topics = new Map<string, Topic>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private getTopic(name: string): Topic | undefined {
    if (!this.config.pubsub.enabled) return undefined;
    if (!this.client) {
      this.client = new PubSub({ projectId: this.config.pubsub.projectId });
    }
    let topic = this.topics.get(name);
    if (!topic) {
      // messageOrdering must be enabled on the publisher to use orderingKey.
      topic = this.client.topic(name, { messageOrdering: true });
      this.topics.set(name, topic);
    }
    return topic;
  }

  /** Publish one envelope to the topic matching its type. Returns the message
   *  id, or null when disabled/unrouted. */
  async publish(event: CloudEvent): Promise<string | null> {
    const topicName = topicForEventType(event.type);
    if (!topicName) {
      this.logger.warn(`No topic mapping for event type ${event.type}; dropping ${event.id}`);
      return null;
    }

    const topic = this.getTopic(topicName);
    if (!topic) {
      this.logger.debug(
        `[pubsub-disabled] ${event.type} → ${topicName} ${event.subject} (${event.id})`,
      );
      return null;
    }

    const attributes: Record<string, string> = {
      'ce-id': event.id,
      'ce-type': event.type,
      'ce-source': event.source,
      'ce-specversion': event.specversion,
      'ce-subject': event.subject,
      'ce-time': event.time,
    };
    if (event.traceparent) attributes['ce-traceparent'] = event.traceparent;
    if (event.tracestate) attributes['ce-tracestate'] = event.tracestate;

    try {
      return await topic.publishMessage({
        data: Buffer.from(JSON.stringify(event)),
        attributes,
        orderingKey: event.subject,
      });
    } catch (err) {
      topic.resumePublishing(event.subject);
      throw err;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) await this.client.close();
  }
}
