/* eslint-disable prettier/prettier */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../queues/queue.constants';
import { FulfillmentServicesService, MAX_SEND_ATTEMPTS } from './fulfillment.service';

/** One job = one fulfilment request. A redelivered job finds it already sent and does nothing. */
@Processor(QUEUE_NAMES.FULFILLMENT_SEND)
export class FulfillmentProcessor extends WorkerHost {
  constructor(private readonly svc: FulfillmentServicesService) { super(); }
  async process(job: Job<{ requestId: string }>): Promise<void> {
    const attempts = job.opts?.attempts ?? MAX_SEND_ATTEMPTS;
    await this.svc.processSend(String(job.data?.requestId ?? ''), (job.attemptsMade ?? 0) + 1 >= attempts);
  }
}
