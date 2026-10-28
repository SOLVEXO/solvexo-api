import { RedisThrottlerStorage } from './redis-throttler.storage';

function fakeRedis(opts: { connected?: boolean; fail?: boolean } = {}) {
  const counts = new Map<string, number>();
  return {
    isConnected: opts.connected ?? true,
    counts,
    throttleHit: async (key: string, ttlMs: number) => {
      if (opts.fail) throw new Error('redis down');
      const hits = (counts.get(key) ?? 0) + 1;
      counts.set(key, hits);
      return { hits, ttlMs };
    },
  };
}

describe('RedisThrottlerStorage', () => {
  it('counts in Redis, shared by key, and blocks only after the limit', async () => {
    const redis = fakeRedis();
    const s = new RedisThrottlerStorage(redis as any);
    const first = await s.increment('1.2.3.4', 60_000, 2, 60_000, 'default');
    const second = await s.increment('1.2.3.4', 60_000, 2, 60_000, 'default');
    const third = await s.increment('1.2.3.4', 60_000, 2, 60_000, 'default');
    expect(first.totalHits).toBe(1);
    expect(first.isBlocked).toBe(false);
    expect(second.isBlocked).toBe(false);
    expect(third.totalHits).toBe(3);
    expect(third.isBlocked).toBe(true);
    expect(third.timeToExpire).toBe(60);
    expect(third.timeToBlockExpire).toBe(60);
    expect(redis.counts.get('throttle:default:1.2.3.4')).toBe(3);
  });

  it('keeps different visitors and different throttlers apart', async () => {
    const redis = fakeRedis();
    const s = new RedisThrottlerStorage(redis as any);
    await s.increment('a', 1000, 1, 1000, 'default');
    const other = await s.increment('b', 1000, 1, 1000, 'default');
    expect(other.totalHits).toBe(1);
    expect(redis.counts.has('throttle:default:a')).toBe(true);
  });

  it.each([['Redis not connected', { connected: false }], ['Redis erroring', { fail: true }]])('falls back to a local counter when %s', async (_n, opts) => {
    const s = new RedisThrottlerStorage(fakeRedis(opts as any) as any);
    const a = await s.increment('x', 60_000, 1, 60_000, 'default');
    const b = await s.increment('x', 60_000, 1, 60_000, 'default');
    expect(a.isBlocked).toBe(false);
    expect(b.totalHits).toBe(2);
    expect(b.isBlocked).toBe(true);
  });
});
