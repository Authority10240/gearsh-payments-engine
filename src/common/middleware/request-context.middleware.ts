import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

function synthesiseTraceparent(): string {
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  return `00-${traceId}-${spanId}-01`;
}

/**
 * Assigns a stable requestId + traceparent to every request (conventions §12)
 * so logs and RFC 7807 envelopes correlate. Honours inbound X-Request-Id and
 * W3C traceparent; synthesises them otherwise.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incomingId = req.header('x-request-id');
    req.requestId = incomingId && incomingId.length <= 200 ? incomingId : uuidv7();

    const incomingTp = req.header('traceparent');
    req.traceparent =
      incomingTp && TRACEPARENT_RE.test(incomingTp) ? incomingTp : synthesiseTraceparent();

    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('traceparent', req.traceparent);
    next();
  }
}
