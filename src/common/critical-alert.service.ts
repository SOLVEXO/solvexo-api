/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from '../otp/services/email.service';

export interface CriticalAlertPayload {
  title: string;
  message: string;
  context?: Record<string, string | number | boolean | null | undefined>;
}

/**
 * Real, previously-missing outbound monitoring for genuine system failures
 * in the billing pipeline (a Stripe billing webhook that permanently failed
 * after every BullMQ retry, an unexpected exception mid-renewal/grace-period
 * cron) — deliberately NOT wired to expected/handled business outcomes like
 * a declined card (that's normal dunning, already surfaced to the seller via
 * PlatformPlanNotificationsService) or a seller choosing to cancel.
 *
 * Delivers to whichever real channel is actually configured, in order:
 * Slack (`SLACK_ALERTS_WEBHOOK_URL`) and/or email (`PLATFORM_ALERTS_EMAIL`,
 * via the same `EmailService` every other transactional email in this
 * codebase already uses) — PLUS always a structured `Logger.error` either
 * way, so nothing is ever silently dropped. With NEITHER env var set, this
 * degrades to exactly today's behavior (log-only, visible in the hosting
 * platform's log viewer) — real push delivery turns on the moment either is
 * configured, no code changes needed then. Never throws: an alert-delivery
 * failure must never break the billing flow that triggered it.
 */
@Injectable()
export class CriticalAlertService {
  private readonly logger = new Logger(CriticalAlertService.name);

  constructor(private readonly emailService: EmailService) {}

  async send(payload: CriticalAlertPayload): Promise<void> {
    const { title, message, context } = payload;
    const contextLines = context
      ? Object.entries(context).map(([k, v]) => `${k}: ${v ?? '—'}`).join('\n')
      : '';

    // The one guaranteed channel — fires regardless of what else is
    // configured, matching every other unrouted error in this codebase.
    this.logger.error(`[CRITICAL] ${title} — ${message}${contextLines ? `\n${contextLines}` : ''}`);

    const slackUrl = process.env.SLACK_ALERTS_WEBHOOK_URL;
    const alertEmail = process.env.PLATFORM_ALERTS_EMAIL;
    if (!slackUrl && !alertEmail) return; // disclosed no-op — see doc comment

    await Promise.allSettled([
      slackUrl ? this.sendSlack(slackUrl, title, message, context) : Promise.resolve(),
      alertEmail ? this.sendEmail(alertEmail, title, message, contextLines) : Promise.resolve(),
    ]);
  }

  private async sendSlack(url: string, title: string, message: string, context?: CriticalAlertPayload['context']): Promise<void> {
    try {
      const fields = context
        ? Object.entries(context).map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}:* ${v ?? '—'}` }))
        : [];
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `🚨 ${title}\n${message}`,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `🚨 *${title}*\n${message}` } },
            ...(fields.length ? [{ type: 'section', fields }] : []),
          ],
        }),
      });
      if (!res.ok) this.logger.warn(`Slack alert webhook returned ${res.status}`);
    } catch (err: any) {
      this.logger.warn(`Slack alert delivery failed (non-fatal): ${err?.message}`);
    }
  }

  private async sendEmail(to: string, title: string, message: string, contextBlock: string): Promise<void> {
    try {
      await this.emailService.sendMail(
        to,
        `[Solvexo Alert] ${title}`,
        `<p><strong>${title}</strong></p><p>${message}</p>${contextBlock ? `<pre style="background:#f4f4f4;padding:12px;border-radius:6px;white-space:pre-wrap;">${contextBlock}</pre>` : ''}`,
      );
    } catch (err: any) {
      this.logger.warn(`Email alert delivery failed (non-fatal): ${err?.message}`);
    }
  }
}
