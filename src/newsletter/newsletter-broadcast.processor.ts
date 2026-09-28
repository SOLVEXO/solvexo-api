/* eslint-disable prettier/prettier */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DatabaseService } from '@/database/databaseservice';
import { EmailService } from '@/otp/services/email.service';
import { QUEUE_NAMES } from '@/queues/queue.constants';
import { newsletterUnsubscribeUrl } from './newsletter-consent.util';
import { renderMarketingEmail, renderMergeTags, textToHtml, unsubscribeHeaders } from './marketing-email.util';

const APP_NAME = process.env.APP_NAME || 'Solvexo';

export interface NewsletterBroadcastJob {
  broadcastId: string;
  email: string;
  unsubscribeToken: string;
  subject: string;
  message: string;
}

/** One job per recipient of an admin broadcast — survives restarts/deploys
 *  and retries a transient SMTP failure with BullMQ backoff (same pattern as
 *  EmailCampaignsProcessor). A recipient only counts as failed once every
 *  attempt is used up; the broadcast flips to 'sent' when all are resolved. */
@Processor(QUEUE_NAMES.NEWSLETTER_BROADCASTS)
export class NewsletterBroadcastProcessor extends WorkerHost {
  private readonly logger = new Logger(NewsletterBroadcastProcessor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly emailService: EmailService,
  ) {
    super();
  }

  async process(job: Job<NewsletterBroadcastJob>): Promise<void> {
    const { broadcastId, email, unsubscribeToken, subject, message } = job.data;
    const unsubscribeUrl = newsletterUnsubscribeUrl(unsubscribeToken);

    // Skip anyone who unsubscribed after the broadcast was queued.
    const stillSubscribed = await this.db.repositories.newsletterSubscriberModel.exists({ storeId: null, email, isActive: true });
    if (!stillSubscribed) return this.record(broadcastId, 'skipped');

    const sent = await this.emailService.sendMail(
      email,
      subject,
      renderMarketingEmail({
        senderName: APP_NAME,
        bodyHtml: textToHtml(renderMergeTags(message, { storeName: APP_NAME, customerName: 'there' })),
        reason: `You're receiving this because you subscribed to ${APP_NAME} updates.`,
        unsubscribeUrl,
      }),
      null,
      unsubscribeHeaders(unsubscribeUrl),
    ).catch(() => false);

    if (sent) return this.record(broadcastId, 'sent');

    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade + 1 >= attempts) {
      this.logger.warn(`Broadcast ${broadcastId}: giving up on ${email}`);
      return this.record(broadcastId, 'failed');
    }
    throw new Error('sendMail returned false'); // let BullMQ retry with backoff
  }

  private async record(broadcastId: string, outcome: 'sent' | 'failed' | 'skipped') {
    const model = this.db.repositories.newsletterBroadcastModel;
    const inc = outcome === 'sent' ? { sentCount: 1 } : { failedCount: outcome === 'failed' ? 1 : 0, recipientCount: outcome === 'skipped' ? -1 : 0 };
    const row = await model.findOneAndUpdate({ _id: broadcastId }, { $inc: inc }, { new: true }).lean();
    if (row && row.status === 'sending' && row.sentCount + row.failedCount >= row.recipientCount) {
      await model.updateOne(
        { _id: broadcastId, status: 'sending' },
        { $set: { status: row.sentCount === 0 && row.recipientCount > 0 ? 'failed' : 'sent', completedAt: new Date() } },
      );
    }
  }
}
