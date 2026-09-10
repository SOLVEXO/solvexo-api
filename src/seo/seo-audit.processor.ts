/* eslint-disable prettier/prettier */
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '@/queues/queue.constants';
import { SeoAuditService } from './services/seo-audit.service';

@Processor(QUEUE_NAMES.SEO_AUDIT)
export class SeoAuditProcessor extends WorkerHost {
  private readonly logger = new Logger(SeoAuditProcessor.name);

  constructor(private readonly auditService: SeoAuditService) {
    super();
  }

  async process(job: Job<{ storeId: string }>): Promise<void> {
    await this.auditService.run(job.data.storeId);
  }

  @OnWorkerEvent('failed')
  handleFailed(job: Job, err: Error) {
    this.logger.error(`SEO audit job ${job.id} (store ${job.data?.storeId}) failed after ${job.attemptsMade} attempts: ${err.message}`);
  }
}
