/* eslint-disable prettier/prettier */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SubscriptionNotificationsService } from './subscription-notifications.service';
import { QUEUE_NAMES } from 'src/queues/queue.constants';

/**
 * Sends every subscription-related email through a durable, retried queue
 * instead of an un-awaited fire-and-forget call inline in the request/cron
 * path. SMTP latency/outages no longer risk slowing down (or silently
 * dropping, on process exit) a billing-critical notification.
 */
@Processor(QUEUE_NAMES.SUBSCRIPTION_EMAILS)
export class SubscriptionEmailProcessor extends WorkerHost {
  private readonly logger = new Logger(SubscriptionEmailProcessor.name);

  constructor(private readonly notifications: SubscriptionNotificationsService) {
    super();
  }

  async process(job: Job<{ kind: string; to: string; data: Record<string, any> }>): Promise<void> {
    const { kind, to, data } = job.data;
    const handler = (this.notifications as any)[kind];
    if (typeof handler !== 'function') {
      this.logger.error(`Unknown subscription email kind "${kind}" — dropping job ${job.id}`);
      return;
    }
    await handler.call(this.notifications, to, data);
  }
}
