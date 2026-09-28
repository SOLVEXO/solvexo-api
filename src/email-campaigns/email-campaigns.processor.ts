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
      await this.emailCampaignsService.markSendResult(sendId, campaignId, sent, sent ? undefined : 'sendMail returned false');
    } catch (e: any) {
      this.logger.error(`EmailCampaignsProcessor: failed for send ${sendId}: ${e?.message}`);
      await this.emailCampaignsService.markSendResult(sendId, campaignId, false, e?.message ?? 'unknown error');
      throw e; // let BullMQ's own retry/backoff apply
    }
  }
}
