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
}
