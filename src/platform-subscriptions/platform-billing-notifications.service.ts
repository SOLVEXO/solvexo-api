/* eslint-disable prettier/prettier */
/**
 * @deprecated RETIRED (Option A / Shopify parity: ONE billing system = src/platform-plans). This file is no longer
 * mounted (not imported by AppModule/SchedulerModule); kept only so the schema/model stays registered and the
 * historical data remains readable. Do not extend; do not re-import.
 */
import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from '../otp/services/email.service';
import { notificationEmailShell } from '../notifications/templates/notification-email.template';


/** Solvexo's shared branded layout (wordmark, card, footer) — the same one every platform email uses. */
function shell(title: string, bodyHtml: string): string {
  return notificationEmailShell(title, bodyHtml);
}

const money = (n: number) => `$ ${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

@Injectable()
export class PlatformBillingNotificationsService {
  private readonly logger = new Logger(PlatformBillingNotificationsService.name);

  constructor(private readonly emailService: EmailService) {}

  private async send(to: string, subject: string, html: string) {
    try {
      const ok = await this.emailService.sendMail(to, subject, html);
      if (!ok) this.logger.warn(`Platform billing email not sent (provider returned false): ${subject} -> ${to}`);
    } catch (err) {
      // Never let a notification failure break the billing flow that triggered it.
      this.logger.error(`Failed to send platform billing email "${subject}" to ${to}: ${err?.message}`);
    }
  }

  async sendPaymentFailed(to: string, data: {
    sellerName: string; storeName: string; tierName: string; amountUSD: number;
    attemptNumber: number; maxAttempts: number; nextRetryDate: Date;
  }) {
    const html = shell('Payment failed', `
      <p>Hi ${data.sellerName},</p>
      <p>We couldn't process your platform plan payment for <strong>${data.storeName}</strong> — ${data.tierName}.</p>
      <div class="danger">
        <strong>Attempt ${data.attemptNumber} of ${data.maxAttempts} failed</strong> for ${money(data.amountUSD)}.
      </div>
      <p>We'll automatically retry on <strong>${data.nextRetryDate.toDateString()}</strong>. To avoid your store
      dropping back to the free Starter plan, please make sure your payment method is up to date before then.</p>
    `);
    await this.send(to, `Action needed: payment failed for ${data.storeName}`, html);
  }

  async sendCanceledDueToFailedPayments(to: string, data: {
    sellerName: string; storeName: string; tierName: string; maxAttempts: number;
  }) {
    const html = shell('Plan downgraded', `
      <p>Hi ${data.sellerName},</p>
      <p>Your <strong>${data.storeName}</strong> plan (${data.tierName}) has been downgraded to the free Starter
      plan after ${data.maxAttempts} failed payment attempts.</p>
      <div class="warning">You can upgrade again at any time from your seller settings once your payment method is updated.</div>
    `);
    await this.send(to, `Your ${data.storeName} plan was downgraded`, html);
  }
}
