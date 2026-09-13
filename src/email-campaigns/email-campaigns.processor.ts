/* eslint-disable prettier/prettier */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmailService } from '@/otp/services/email.service';
import { EmailCampaignsService } from './email-campaigns.service';
import { QUEUE_NAMES } from '@/queues/queue.constants';

const PLATFORM_ORIGIN = 'https://solvexo.store';

interface EmailCampaignSendJob {
  sendId: string;
  campaignId: string;
  email: string;
  customerName: string;
  storeName: string;
  subject: string;
  message: string;
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

  private renderTemplate(template: string, vars: Record<string, string>) {
    return Object.entries(vars).reduce((text, [key, val]) => text.split(`{{${key}}}`).join(val), template);
  }

  async process(job: Job<EmailCampaignSendJob>): Promise<void> {
    const { sendId, campaignId, email, customerName, storeName, subject, message } = job.data;

    try {
      const vars = { customerName, storeName };
      const renderedSubject = this.renderTemplate(subject, vars);
      const renderedBody = this.renderTemplate(message, vars);

      // Every click routes through the tracking redirect first; a real open
      // pixel is appended at send time (not authored by the seller).
      const clickUrl = `${PLATFORM_ORIGIN}/api/email-campaigns/track/click/${sendId}`;
      const openPixel = `${PLATFORM_ORIGIN}/api/email-campaigns/track/open/${sendId}`;

      const html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        ${renderedBody}
        <p style="margin-top:24px"><a href="${clickUrl}" style="background:#141413;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Visit ${storeName}</a></p>
        <img src="${openPixel}" width="1" height="1" alt="" style="display:none" />
      </div>`;

      const sent = await this.emailService.sendMail(email, renderedSubject, html);
      await this.emailCampaignsService.markSendResult(sendId, campaignId, sent, sent ? undefined : 'sendMail returned false');
    } catch (e: any) {
      this.logger.error(`EmailCampaignsProcessor: failed for send ${sendId}: ${e?.message}`);
      await this.emailCampaignsService.markSendResult(sendId, campaignId, false, e?.message ?? 'unknown error');
      throw e; // let BullMQ's own retry/backoff apply
    }
  }
}
