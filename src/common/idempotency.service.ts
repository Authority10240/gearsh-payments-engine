import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RedisService } from '../infra/redis/redis.service';
import { AppException } from './problem/app-exception';
import { ErrorCode } from './problem/error-codes';

interface StoredResponse {
  bodyHash: string;
  status: number;
  body: unknown;
}

const TTL_SECONDS = 24 * 60 * 60; // conventions §11

/**
 * Redis-backed Idempotency-Key dedup helper (conventions §11). Scope is
 * (endpoint, userId, key). A replay with the SAME request body returns the
 * stored response; a replay with a DIFFERENT body is IDEMPOTENCY_KEY_MISMATCH.
 *
 * Mutating handlers wrap their work with `run()`; reads ignore the key.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly redis: RedisService) {}

  private key(endpoint: string, userId: string, idempotencyKey: string): string {
    return `idem:${endpoint}:${userId}:${idempotencyKey}`;
  }

  private hash(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(body ?? null))
      .digest('hex');
  }

  /**
   * Execute `work` at most once per (endpoint, user, key). On replay with the
   * same body, returns the cached response and `replayed=true`.
   */
  async run<T>(
    params: { endpoint: string; userId: string; idempotencyKey?: string; requestBody: unknown },
    work: () => Promise<{ status: number; body: T }>,
  ): Promise<{ status: number; body: T; replayed: boolean }> {
    const { endpoint, userId, idempotencyKey, requestBody } = params;
    if (!idempotencyKey) {
      const fresh = await work();
      return { ...fresh, replayed: false };
    }

    const redisKey = this.key(endpoint, userId, idempotencyKey);
    const bodyHash = this.hash(requestBody);

    const existing = await this.redis.get(redisKey);
    if (existing) {
      const stored = JSON.parse(existing) as StoredResponse;
      if (stored.bodyHash !== bodyHash) {
        throw new AppException(ErrorCode.IDEMPOTENCY_KEY_MISMATCH, {
          detail: 'This idempotency key was used with a different request body.',
        });
      }
      return { status: stored.status, body: stored.body as T, replayed: true };
    }

    const result = await work();
    const stored: StoredResponse = {
      bodyHash,
      status: result.status,
      body: result.body,
    };
    await this.redis.set(redisKey, JSON.stringify(stored), 'EX', TTL_SECONDS);
    return { ...result, replayed: false };
  }
}
