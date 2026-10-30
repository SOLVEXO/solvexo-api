import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../queues/queue.constants';
import { MembershipsService } from './memberships.service';

/** BullMQ worker for the hourly membership run: manual renewals + dunning ladder, and the Stripe seven-day cut-off. */
@Processor(QUEUE_NAMES.MEMBERSHIP_BILLING)
export class MembershipBillingProcessor extends WorkerHost {
  private readonly logger = new Logger(MembershipBillingProcessor.name);

  constructor(private readonly memberships: MembershipsService) {
    super();
  }

  async process(): Promise<{ events: number; stripeEnded: number }> {
    const events = await this.memberships.processRenewals();
    const stripeEnded = await this.memberships.reconcileStripeDunning();
    return { events: events.length, stripeEnded };
  }

  @OnWorkerEvent('failed')
  handleFailed(job: Job, err: Error) {
    this.logger.error(`Membership billing job ${job.id} failed after ${job.attemptsMade} attempts: ${err.message}`);
  }
}
