import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { RedisService } from '../redis/redis.service';

/**
 * Rate-limit counters shared by every API instance (needed before running more than one copy: with the default in-memory
 * store each copy counts separately, so the real limit is limit x copies). Enabled with THROTTLE_STORAGE=redis.
 * Fixed window per key (same model as the stock store); the block lasts until the window ends. If Redis is down or errors,
 * the request is counted in this instance's own memory instead: a Redis problem can only relax the limit, never block users.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly fallback = new ThrottlerStorageService();

  constructor(private readonly redis: Pick<RedisService, 'isConnected' | 'throttleHit'>) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    if (this.redis.isConnected) {
      try {
        const { hits, ttlMs } = await this.redis.throttleHit(`throttle:${throttlerName}:${key}`, ttl);
        const isBlocked = hits > limit;
        const secondsLeft = Math.max(1, Math.ceil(ttlMs / 1000));
        return { totalHits: hits, timeToExpire: secondsLeft, isBlocked, timeToBlockExpire: isBlocked ? secondsLeft : 0 };
      } catch {
        /* fall through to the in-memory counter */
      }
    }
    return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
  }
}
