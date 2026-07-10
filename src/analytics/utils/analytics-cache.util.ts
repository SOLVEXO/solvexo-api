/* eslint-disable prettier/prettier */
import { RedisService } from '../../redis/redis.service';

/**
 * Redis-backed memoization wrapper shared by every analytics service (seller + admin).
 * No-ops straight through to `compute()` when Redis is down — analytics must degrade
 * gracefully, never hard-fail, if the cache layer is unavailable.
 */
export async function withAnalyticsCache<T>(
  redis: RedisService,
  cacheKey: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  if (redis.isConnected) {
    const hit = await redis.get(cacheKey);
    if (hit) {
      try {
        return JSON.parse(hit) as T;
      } catch {
        // fall through and recompute on a corrupt cache entry
      }
    }
  }
  const result = await compute();
  if (redis.isConnected) {
    await redis.set(cacheKey, JSON.stringify(result), ttlSeconds);
  }
  return result;
}

/** Cache key convention: `<namespace>:<scopeId>:<section>:<query-json>` — `scopeId` is a storeId for seller analytics, `'platform'` (or a sellerId, for drill-downs) for admin analytics. */
export function buildAnalyticsCacheKey(namespace: string, scopeId: string, section: string, query: Record<string, any>): string {
  return `${namespace}:${scopeId}:${section}:${JSON.stringify(query)}`;
}
