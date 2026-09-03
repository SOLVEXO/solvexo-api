/* eslint-disable prettier/prettier */
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '@/queues/queue.constants';
import { SeoSitemapService } from './services/seo-sitemap.service';
import { SitemapType } from './schemas/seo-sitemap-cache.schema';

@Processor(QUEUE_NAMES.SEO_SITEMAP)
export class SeoSitemapProcessor extends WorkerHost {
  private readonly logger = new Logger(SeoSitemapProcessor.name);

  constructor(private readonly sitemapService: SeoSitemapService) {
    super();
  }

  async process(job: Job<{ type?: SitemapType; storeId?: string }>): Promise<void> {
    await this.sitemapService.regenerate(job.data ?? {});
  }

  @OnWorkerEvent('failed')
  handleFailed(job: Job, err: Error) {
    this.logger.error(`Sitemap regeneration job ${job.id} failed after ${job.attemptsMade} attempts: ${err.message}`);
  }
}
