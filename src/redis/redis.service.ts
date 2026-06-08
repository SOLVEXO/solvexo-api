import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import { ConfigModule } from '@nestjs/config';


@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: RedisClientType;

  constructor() {

    // const redisUrl = process.env.REDIS_URL ||  'redis://localhost:6379';

    this.client = createClient({
      // url: redisUrl,
    });

    this.client.on('error', (err) => console.error('Redis Client Error', err));
  }

  async onModuleInit() {
    await this.client.connect();
    console.log('Redis connected');
  }

  async onModuleDestroy() {
    await this.client.quit();
    console.log('Redis disconnected');
  }

  async set(key: string, value: string, ttl: number) {
    await this.client.set(key, value, { EX: ttl });
  }

  async get(key: string) {
    return await this.client.get(key);
  }

  async del(key: string) {
    return await this.client.del(key);
  }
}
