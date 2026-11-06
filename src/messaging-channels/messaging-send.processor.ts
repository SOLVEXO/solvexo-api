/* eslint-disable prettier/prettier */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../queues/queue.constants';
import { MessagingCampaignsService } from './messaging-campaigns.service';

/** One job = one batch of messages already claimed (queued -> sending). A redelivered job finds them handled and does nothing. */
@Processor(QUEUE_NAMES.MESSAGING_SEND)
export class MessagingSendProcessor extends WorkerHost {
  constructor(private readonly campaigns: MessagingCampaignsService) { super(); }
  async process(job: Job<{ ids: string[] }>): Promise<void> {
    await this.campaigns.sendBatch(Array.isArray(job.data?.ids) ? job.data.ids : []);
  }
}
