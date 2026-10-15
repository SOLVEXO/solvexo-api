/* eslint-disable prettier/prettier */
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../../queues/queue.constants';
import { ThemePackageService } from './theme-package.service';
import { DatabaseService } from '../../database/databaseservice';

/**
 * Runs a theme ZIP import on a BullMQ worker instead of in the HTTP request's own process (`setImmediate`).
 * The job only ever carries `{ jobId }` — the ZIP bytes live on `ThemeImportJob.archive` in Mongo — so a deploy
 * or crash mid-import does not lose the work: Redis still holds the queued job, and whichever process picks it
 * up next reads the same archive back out and finishes it. See `ThemePackageService.processImportJob`.
 */
@Processor(QUEUE_NAMES.THEME_IMPORT)
export class ThemeImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ThemeImportProcessor.name);

  constructor(
    private readonly themePackageService: ThemePackageService,
    private readonly db: DatabaseService,
  ) {
    super();
  }

  async process(job: Job<{ jobId: string }>): Promise<void> {
    await this.themePackageService.processImportJob(job.data.jobId);
  }

  @OnWorkerEvent('failed')
  async handleFailed(job: Job<{ jobId: string }> | undefined, err: Error) {
    this.logger.error(`Theme import job ${job?.id} failed after ${job?.attemptsMade ?? '?'} attempts: ${err.message}`);
    // BullMQ has given up on this job — the ZIP bytes it was holding onto for a possible retry are now dead weight.
    const exhausted = job && job.attemptsMade >= (job.opts.attempts ?? 1);
    if (exhausted && job?.data?.jobId) {
      await this.db.repositories.themeImportJobModel.updateOne({ _id: job.data.jobId }, { $unset: { archive: 1 } }).catch(() => undefined);
    }
  }
}
