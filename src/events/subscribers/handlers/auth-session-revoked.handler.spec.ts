import { AuthSessionRevokedHandler } from './auth-session-revoked.handler';
import type { CloudEvent } from '../../cloud-event';
import type { AppConfig } from '../../../config/configuration';

/**
 * PAY-REPAIR-001 unit tests for the auth.session.revoked subscriber.
 * Mirrors the DATA-REPAIR-001 spec — payments uses a distinct denylist
 * prefix (`payments:sid:denylist:`) and consumer name
 * (`payments-auth-session-revoked`) to keep each engine isolated in
 * shared Redis + processed_events.
 */
function eventOf(data: Record<string, unknown>): CloudEvent {
  return {
    specversion: '1.0',
    id: 'evt-1',
    type: 'auth.session.revoked',
    source: 'gearsh-auth-engine',
    subject: 'user:user-1',
    datacontenttype: 'application/json',
    data,
  } as CloudEvent;
}

describe('AuthSessionRevokedHandler (PAY-REPAIR-001)', () => {
  let redis: { set: jest.Mock };
  let handler: AuthSessionRevokedHandler;
  const config = {
    jwt: { accessTtlSeconds: 900 },
  } as unknown as AppConfig;

  beforeEach(() => {
    redis = { set: jest.fn().mockResolvedValue('OK') };
    handler = new AuthSessionRevokedHandler(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
      config,
    );
  });

  it('claims only auth.session.revoked', () => {
    expect(handler.handles('auth.session.revoked')).toBe(true);
    expect(handler.handles('auth.user.deleted')).toBe(false);
    expect(handler.handles('bookings.completed')).toBe(false);
  });

  it('uses a stable consumer name for dedup', () => {
    expect(handler.consumerName).toBe('payments-auth-session-revoked');
  });

  it('SETs the payments-prefixed denylist key with TTL on single-scope', async () => {
    await handler.handle(
      eventOf({
        userId: 'user-1',
        sid: 'sid-abc',
        scope: 'single',
        revokedAt: new Date().toISOString(),
      }),
    );
    expect(redis.set).toHaveBeenCalledWith('payments:sid:denylist:sid-abc', '1', 'EX', 900);
  });

  it('floors the TTL at 60s when configured shorter', async () => {
    const tinyConfig = { jwt: { accessTtlSeconds: 30 } } as unknown as AppConfig;
    const tinyHandler = new AuthSessionRevokedHandler(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redis as any,
      tinyConfig,
    );
    await tinyHandler.handle(eventOf({ userId: 'user-1', sid: 'sid-floored', scope: 'single' }));
    expect(redis.set).toHaveBeenCalledWith('payments:sid:denylist:sid-floored', '1', 'EX', 60);
  });

  it('is a no-op when scope=all (no sid)', async () => {
    await handler.handle(
      eventOf({
        userId: 'user-1',
        scope: 'all',
      }),
    );
    expect(redis.set).not.toHaveBeenCalled();
  });
});
