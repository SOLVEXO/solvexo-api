/* eslint-disable prettier/prettier */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmailService } from '@/otp/services/email.service';
import { EmailCampaignsService } from './email-campaigns.service';
import { QUEUE_NAMES } from '@/queues/queue.constants';
import { API_PUBLIC_ORIGIN } from '@/common/api-origin';
import { unsubscribeHeaders } from '@/newsletter/marketing-email.util';
import { renderCampaignEmail } from './campaign-email.util';

interface EmailCampaignSendJob {
  sendId: string;
  campaignId: string;
  email: string;
  customerName: string;
  storeName: string;
  subject: string;
  message: string;
  // Optional only for jobs already queued before these fields existed.
  storeContactEmail?: string | null;
  unsubscribeUrl?: string;
  designed?: boolean;
}

/** One job per recipient — SMTP latency/a single bad address never blocks
 *  (or risks losing, on a process crash) the rest of the campaign, and
 *  BullMQ's own retry/backoff covers a transient SMTP failure without any
 *  bespoke retry logic here. Mirrors SubscriptionEmailProcessor exactly. */
@Processor(QUEUE_NAMES.EMAIL_CAMPAIGNS)
export class EmailCampaignsProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailCampaignsProcessor.name);

  constructor(
    private readonly emailService: EmailService,
    private readonly emailCampaignsService: EmailCampaignsService,
  ) {
    super();
  }

  async process(job: Job<EmailCampaignSendJob>): Promise<void> {
    const { sendId, campaignId, email, customerName, storeName, subject, message, storeContactEmail, unsubscribeUrl, designed } = job.data;

    const maxAttempts = job.opts.attempts ?? 1;
    const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;

    // Redelivery guard: a recipient already sent must never be emailed twice.
    const existing = await this.emailCampaignsService.getSendState(sendId);
    if (!existing || existing.sentAt || existing.failedAt) return;

    try {
      // Every click routes through the tracking redirect first (the redirect
      // only honours targets that are really in this campaign); a real open
      // pixel is appended at send time (not authored by the seller).
      const clickBase = `${API_PUBLIC_ORIGIN}/api/email-campaigns/track/click/${sendId}`;
      const rendered = renderCampaignEmail({
        subject, message, customerName, storeName,
        designed: !!designed,
        trackLink: (href) => `${clickBase}?u=${encodeURIComponent(href)}`,
        ctaUrl: clickBase,
        openPixelUrl: `${API_PUBLIC_ORIGIN}/api/email-campaigns/track/open/${sendId}`,
        unsubscribeUrl: unsubscribeUrl ?? null,
      });
      const sent = await this.emailService.sendMail(email, rendered.subject, rendered.html, storeContactEmail ?? null, unsubscribeHeaders(unsubscribeUrl));
      if (sent) {
        await this.emailCampaignsService.markSendResult(sendId, campaignId, true);
        return;
      }
      // sendMail swallows SMTP errors and returns false (it cannot tell an
      // invalid address from a transient outage), so retry with backoff and
      // only record a permanent failure once attempts are exhausted.
      throw new Error('sendMail returned false');
    } catch (e: any) {
      this.logger.warn(`EmailCampaignsProcessor: send ${sendId} attempt ${job.attemptsMade + 1}/${maxAttempts} failed: ${e?.message}`);
      if (isLastAttempt) {
        await this.emailCampaignsService.markSendResult(sendId, campaignId, false, e?.message ?? 'unknown error');
        return; // resolved as failed — don't leave the job in a failed state
      }
      throw e; // let BullMQ's retry/backoff apply; recipient stays pending
    }
  }
}
