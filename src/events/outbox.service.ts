import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService } from '../infra/prisma/prisma.service';
import { dataSchemaUri, EVENT_SOURCE } from './event-types';
import type { OutboxPayload } from './cloud-event';

type OutboxClient = Prisma.TransactionClient | PrismaService;

export interface EnqueueInput {
  aggregateType: string;
  aggregateId: string;
  type: string;
  subject: string;
  data: Record<string, unknown>;
  traceparent?: string;
  tracestate?: string;
}

/**
 * Transactional outbox (events/README §3). Callers enqueue an event inside the
 * SAME DB transaction as the state change; the OutboxDispatcher publishes it to
 * Pub/Sub afterwards. This prevents "event emitted but state not committed".
 */
@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(client: OutboxClient, input: EnqueueInput): Promise<string> {
    const id = uuidv7();
    const payload: OutboxPayload = {
      specversion: '1.0',
      type: input.type,
      source: EVENT_SOURCE,
      subject: input.subject,
      datacontenttype: 'application/json',
      dataschema: dataSchemaUri(input.type),
      data: input.data,
      traceparent: input.traceparent ?? '',
      tracestate: input.tracestate ?? '',
    };

    await client.outboxEvent.create({
      data: {
        id,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.type,
        subject: input.subject,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    });

    return id;
  }
}
