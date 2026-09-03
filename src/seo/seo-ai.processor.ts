/* eslint-disable prettier/prettier */
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger, BadRequestException } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '@/queues/queue.constants';
import { SeoAiService } from './services/seo-ai.service';

interface BulkGenerateJobData {
  entityType: 'product' | 'category' | 'store';
  entityIds: string[];
  storeId: string;
  sellerId: string;
  actor: { id: string; name?: string; role?: string };
}

/**
 * Processes `generate-suggestion-bulk` jobs — generates one at a time (not
 * in parallel, so credit-wallet balance checks stay accurate between
 * items) and stops gracefully the moment the wallet runs out, reporting
 * partial success rather than failing the whole batch.
 */
@Processor(QUEUE_NAMES.SEO_AI)
export class SeoAiProcessor extends WorkerHost {
  private readonly logger = new Logger(SeoAiProcessor.name);

  constructor(private readonly seoAiService: SeoAiService) {
    super();
  }

  async process(job: Job<BulkGenerateJobData>): Promise<{ succeeded: string[]; failed: Array<{ entityId: string; reason: string }> }> {
    const { entityType, entityIds, sellerId, actor } = job.data;
    const succeeded: string[] = [];
    const failed: Array<{ entityId: string; reason: string }> = [];

    for (const entityId of entityIds) {
      try {
        await this.seoAiService.generate(entityType, entityId, sellerId, actor);
        succeeded.push(entityId);
      } catch (err: any) {
        failed.push({ entityId, reason: err?.message ?? 'Unknown error' });
        // Insufficient-credit failures won't resolve by continuing to the next item — stop the batch early.
        if (err instanceof BadRequestException && /credit/i.test(err.message)) {
          this.logger.warn(`Bulk AI SEO generation stopped early — credit wallet exhausted after ${succeeded.length}/${entityIds.length} items.`);
          break;
        }
      }
    }

    return { succeeded, failed };
  }

  @OnWorkerEvent('failed')
  handleFailed(job: Job, err: Error) {
    this.logger.error(`Bulk AI SEO generation job ${job.id} failed after ${job.attemptsMade} attempts: ${err.message}`);
  }
}
