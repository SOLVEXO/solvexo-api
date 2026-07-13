/* eslint-disable prettier/prettier */
import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QUEUE_NAMES } from './queue.constants';

/**
 * Central BullMQ wiring — one Redis connection, shared by every named queue.
 * `@Global()` so any module can `@InjectQueue(QUEUE_NAMES.X)` without
 * re-importing this module everywhere (same pattern as SubscriptionsModule).
 *
 * Why queues at all: Stripe expects a webhook response within ~10s or it
 * retries the delivery. Doing the real DB work (transactional subscription
 * update + seller payout credit + notification) synchronously inside the
 * webhook request risks a timeout under load, which would cause Stripe to
 * redeliver a webhook whose side effects may have partially completed.
 * Instead the controller only verifies + persists the raw event, enqueues a
 * job, and returns 200 immediately; a worker processes it with BullMQ's
 * built-in exponential-backoff retry — and a `failed` listener demotes
 * exhausted jobs into a queryable dead-letter record (see
 * `WebhookEvent.status = 'failed'`) instead of silently vanishing.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get<string>('REDIS_URL') || 'redis://localhost:6379',
          maxRetriesPerRequest: null, // required by BullMQ's blocking connections
        },
      }),
    }),
    BullModule.registerQueue(
      {
        name: QUEUE_NAMES.STRIPE_WEBHOOKS,
        defaultJobOptions: {
          attempts: 6,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: false, // keep failed jobs visible for the dead-letter view
        },
      },
      {
        name: QUEUE_NAMES.SUBSCRIPTION_EMAILS,
        defaultJobOptions: {
          attempts: 4,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: { count: 5000 },
          removeOnFail: { count: 5000 },
        },
      },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
