/* eslint-disable prettier/prettier */
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: RedisClientType;
  private connected = false;
  private readonly logger = new Logger(RedisService.name);

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    this.client = createClient({ url: redisUrl });

    this.client.on('error', () => {
      if (this.connected) {
        this.connected = false;
        this.logger.warn('Redis disconnected');
      }
    });
  }

  async onModuleInit() {
    try {
      await this.client.connect();
      this.connected = true;
      this.logger.log('Redis connected');
    } catch {
      this.logger.warn('Redis unavailable — OTP/session features disabled');
    }
  }

  async onModuleDestroy() {
    if (this.connected) {
      await this.client.quit();
    }
  }

  async set(key: string, value: string, ttl: number) {
    if (!this.connected) return;
    await this.client.set(key, value, { EX: ttl });
  }

  get isConnected() { return this.connected; }

  async get(key: string): Promise<string | null> {
    if (!this.connected) return null;
    return await this.client.get(key);
  }

  async del(key: string) {
    if (!this.connected) return;
    await this.client.del(key);
  }

  /**
   * Atomic increment-with-expiry for fixed-window rate-limit counters. Returns
   * the post-increment count, or null if Redis is unavailable — callers must
   * fail-open (allow the request) rather than block legitimate traffic just
   * because Redis itself is down.
   */
  async incrWithTtl(key: string, ttlSeconds: number): Promise<number | null> {
    if (!this.connected) return null;
    const count = await this.client.incr(key);
    if (count === 1) await this.client.expire(key, ttlSeconds);
    return count;
  }

  // ── Distributed locking (Redlock-lite, single-instance Redis) ────────────
  // Used to serialize cron jobs (renewals, dunning, cancellation finalization)
  // across horizontally-scaled app instances so the same subscription is never
  // charged twice in the same tick. Safe unlock via a compare-and-delete Lua
  // script so an instance can never release a lock it doesn't own (e.g. after
  // its own lock already expired and a different instance acquired it).
  private static readonly UNLOCK_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  /**
   * Attempts to acquire an exclusive lock. Returns a token to release it with,
   * or null if the lock is already held elsewhere (or Redis is unavailable —
   * callers must treat "unavailable" as "could not confirm exclusivity" and
   * skip the guarded work rather than proceed unprotected).
   */
  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    if (!this.connected) return null;
    const token = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const result = await this.client.set(key, token, { NX: true, PX: ttlMs });
    return result === 'OK' ? token : null;
  }

  async releaseLock(key: string, token: string): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client.eval(RedisService.UNLOCK_SCRIPT, { keys: [key], arguments: [token] });
    } catch {
      // best-effort — the lock will simply expire via its own TTL
    }
  }

  /**
   * Runs `fn` only if the lock is acquired; otherwise no-ops. This is the
   * primitive every cron job should wrap itself in before doing platform-wide
   * work, so that N horizontally-scaled instances only ever have one winner
   * per tick.
   */
  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | 'lock_not_acquired'> {
    const token = await this.acquireLock(key, ttlMs);
    if (!token) return 'lock_not_acquired';
    try {
      return await fn();
    } finally {
      await this.releaseLock(key, token);
    }
  }
}
