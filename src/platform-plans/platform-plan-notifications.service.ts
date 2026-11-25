/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from '../otp/services/email.service';
import { notificationEmailShell } from '../notifications/templates/notification-email.template';


/** Solvexo's shared branded layout (wordmark, card, footer) — the same one every platform email uses. */
function shell(title: string, bodyHtml: string): string {
  return notificationEmailShell(title, bodyHtml);
}

const money = (n: number) => `$ ${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Seller-facing emails for platform-plan (seller-to-Solvexo) billing — same visual style/shell as SubscriptionNotificationsService, different audience (sellers, not buyers). */
@Injectable()
export class PlatformPlanNotificationsService {
  private readonly logger = new Logger(PlatformPlanNotificationsService.name);

  constructor(private readonly emailService: EmailService) {}

  /** `to` may be one address or the owner + billing-staff list; each recipient is sent separately so one bad address never blocks the rest. */
  private async send(to: string | string[], subject: string, html: string) {
    const recipients = Array.from(new Set((Array.isArray(to) ? to : [to]).filter((e) => typeof e === 'string' && e.trim())));
    for (const addr of recipients) {
      try {
        const ok = await this.emailService.sendMail(addr, subject, html);
        if (!ok) this.logger.warn(`Platform-plan email not sent (provider returned false): ${subject} -> ${addr}`);
      } catch (err: any) {
        // Never let a notification failure break the billing flow that triggered it.
        this.logger.error(`Failed to send platform-plan email "${subject}" to ${addr}: ${err?.message}`);
      }
    }
  }

  async sendPlanUpgraded(to: string | string[], data: {
    sellerName: string; storeName: string; fromPlanName: string; toPlanName: string; amountUSD: number;
  }) {
    const html = shell('Your platform plan was changed', `
      <p>Hi ${data.sellerName},</p>
      <p>Your store <strong>${data.storeName}</strong>'s Solvexo platform plan has been updated.</p>
      <div class="box">
        <table role="presentation" width="100%" style="border-collapse:collapse;"><tr><td style="padding:6px 0;font-size:14px;color:#767676;text-align:left;">Previous plan</td><td style="padding:6px 0 6px 16px;font-size:14px;font-weight:600;color:#222;text-align:right;">${data.fromPlanName}</td></tr></table>
        <table role="presentation" width="100%" style="border-collapse:collapse;"><tr><td style="padding:6px 0;font-size:14px;color:#767676;text-align:left;">New plan</td><td style="padding:6px 0 6px 16px;font-size:14px;font-weight:600;color:#222;text-align:right;">${data.toPlanName}</td></tr></table>
      </div>
      <div class="amount">${money(data.amountUSD)} charged</div>
      <p style="text-align:center;color:#666;font-size:13px;">This is a prorated charge for the remainder of your current billing period.</p>
    `);
    await this.send(to, `Your platform plan was changed — ${money(data.amountUSD)} charged`, html);
  }

  async sendPlanChangeCredited(to: string | string[], data: {
    sellerName: string; storeName: string; fromPlanName: string; toPlanName: string; creditUSD: number;
  }) {
    const html = shell('Your platform plan was changed', `
      <p>Hi ${data.sellerName},</p>
      <p>Your store <strong>${data.storeName}</strong>'s Solvexo platform plan has been updated.</p>
      <div class="box">
        <table role="presentation" width="100%" style="border-collapse:collapse;"><tr><td style="padding:6px 0;font-size:14px;color:#767676;text-align:left;">Previous plan</td><td style="padding:6px 0 6px 16px;font-size:14px;font-weight:600;color:#222;text-align:right;">${data.fromPlanName}</td></tr></table>
        <table role="presentation" width="100%" style="border-collapse:collapse;"><tr><td style="padding:6px 0;font-size:14px;color:#767676;text-align:left;">New plan</td><td style="padding:6px 0 6px 16px;font-size:14px;font-weight:600;color:#222;text-align:right;">${data.toPlanName}</td></tr></table>
      </div>
      <div class="success">
        <strong>No charge today.</strong> ${money(data.creditUSD)} in unused time has been credited to your
        account and will automatically reduce your next bill.
      </div>
    `);
    await this.send(to, `Your platform plan was changed — ${money(data.creditUSD)} credited to your account`, html);
  }

  async sendMovedToFreePlan(to: string | string[], data: { sellerName: string; storeName: string; planName: string }) {
    const html = shell('Your plan is now free', `
      <p>Hi ${data.sellerName},</p>
      <p>Your store <strong>${data.storeName}</strong> is now on the free "${data.planName}" plan.</p>
      <div class="box">You can upgrade again any time from your seller dashboard — no long-term commitment either way.</div>
    `);
    await this.send(to, `${data.storeName} moved to the free plan`, html);
  }

  async sendPaymentReceived(to: string | string[], data: {
    sellerName: string; storeName: string; planName: string; amountUSD: number; invoiceUrl?: string | null;
  }) {
    const linkLine = data.invoiceUrl
      ? `<p style="text-align:center;"><a href="${data.invoiceUrl}">View your invoice</a></p>`
      : '';
    const html = shell('Payment received', `
      <p>Hi ${data.sellerName},</p>
      <p>Thank you — we received your platform-plan payment for <strong>${data.storeName}</strong> (${data.planName}).</p>
      <div class="amount">${money(data.amountUSD)} paid</div>
      ${linkLine}
    `);
    await this.send(to, `Payment received — ${money(data.amountUSD)} for ${data.storeName}`, html);
  }

  async sendPaymentFailed(to: string | string[], data: {
    sellerName: string; storeName: string; planName: string; amountUSD: number;
    attemptNumber: number; maxAttempts: number; nextRetryDate: Date | null; lockDate?: Date | null;
  }) {
    const retryLine = data.nextRetryDate
      ? `We'll automatically retry on <strong>${data.nextRetryDate.toDateString()}</strong>.`
      : `We'll keep trying while your card is on file.`;
    const lockLine = data.lockDate
      ? `If the payment is still unpaid on <strong>${data.lockDate.toDateString()}</strong>, your store will be locked (selling paused; your data stays safe).`
      : `To avoid your store being locked (selling paused), please make sure your payment method is up to date.`;
    const html = shell('Platform plan payment failed', `
      <p>Hi ${data.sellerName},</p>
      <p>We couldn't process your platform-plan payment for <strong>${data.storeName}</strong> — ${data.planName}.</p>
      <div class="danger">
        <strong>Payment failed</strong> for ${money(data.amountUSD)}.
      </div>
      <p>${retryLine} ${lockLine} Update your payment method from Plan &amp; Billing to avoid this.</p>
    `);
    await this.send(to, `Action needed: payment failed for ${data.storeName}`, html);
  }

  async sendDowngradedDueToFailedPayments(to: string | string[], data: { sellerName: string; storeName: string; planName: string; maxAttempts: number }) {
    const html = shell('Your store was downgraded', `
      <p>Hi ${data.sellerName},</p>
      <p>Your store <strong>${data.storeName}</strong> has been moved to the free "${data.planName}" plan after
      ${data.maxAttempts} failed payment attempts.</p>
      <div class="warning">Any features exclusive to your previous tier (staff seats, custom domain, loyalty program,
      etc.) are now paused until you upgrade again — your store and existing data are safe and unaffected.</div>
    `);
    await this.send(to, `${data.storeName} was moved to the free plan after failed payments`, html);
  }

  /** Trial-based-model equivalent of sendDowngradedDueToFailedPayments — there's no free plan to fall back to, so the store is locked (selling restricted) instead, never deleted/hidden. */
  async sendStoreLocked(to: string | string[], data: { sellerName: string; storeName: string; reason: 'trial_ended' | 'payment_failed' | 'subscription_ended' }) {
    const reasonText = {
      trial_ended: 'your free trial ended without an active paid plan',
      payment_failed: 'repeated payment attempts failed',
      subscription_ended: 'your subscription ended',
    }[data.reason];
    const html = shell('Your store has been locked', `
      <p>Hi ${data.sellerName},</p>
      <p>Your store <strong>${data.storeName}</strong> has been locked because ${reasonText}.</p>
      <div class="danger">Selling and checkout are paused for now — but every product, order, customer, and setting is
      untouched and safe.</div>
      <p>Choose a plan and add a payment method any time to unlock your store immediately.</p>
    `);
    await this.send(to, `${data.storeName} has been locked — action needed`, html);
  }

  /**
   * Distinct from `sendStoreLocked` — this fires DAYS LATER, once a locked/
   * trial-ended store's grace period elapses and its storefront actually
   * stops being browsable to buyers (Store.privacyMode -> 'coming_soon').
   * Selling/checkout was already blocked the moment the store was locked;
   * this is the escalation the seller needs to know about separately, not a
   * duplicate of the original lock email.
   */
  /** Real gap fixed: no PAID (non-trial) subscription ever got a "you'll be
   *  charged $X in N days" reminder before this — only a trial's own end
   *  date had one (sendTrialEndingSoon). See
   *  SellerPlatformSubscriptionsService.sendUpcomingRenewalReminders. */
  async sendUpcomingRenewalReminder(to: string | string[], data: { sellerName: string; storeName: string; planName: string; amountUSD: number; renewalDate: Date }) {
    const html = shell('Upcoming renewal', `
      <p>Hi ${data.sellerName},</p>
      <p>${data.storeName}'s <strong>${data.planName}</strong> plan will renew on <strong>${data.renewalDate.toDateString()}</strong>.</p>
      <div class="amount">${money(data.amountUSD)} will be charged</div>
      <p style="text-align:center;color:#666;font-size:13px;">No action needed if you want to continue — this is just a heads-up before your card is charged.</p>
    `);
    await this.send(to, `${data.storeName}'s plan renews on ${data.renewalDate.toDateString()} — ${money(data.amountUSD)}`, html);
  }

  async sendStorefrontHidden(to: string | string[], data: { sellerName: string; storeName: string }) {
    const html = shell('Your storefront is now hidden from buyers', `
      <p>Hi ${data.sellerName},</p>
      <p>Your store <strong>${data.storeName}</strong>'s grace period has ended — your storefront is no longer visible to buyers, on top of selling already being paused.</p>
      <div class="danger">Every product, order, customer, and setting is still untouched and safe.</div>
      <p>Choose a plan and add a payment method any time to make your store visible and sellable again immediately.</p>
    `);
    await this.send(to, `${data.storeName}'s storefront is now hidden — action needed`, html);
  }

  /**
   * `committedPlan` is optional and, under the current onboarding/Billing
   * UI, never actually set any more — trial is a standalone concept (no
   * plan attached, see `PlatformTrialSettings`), and the one dormant backend
   * path that could pre-commit a store to a plan mid-trial without charging
   * yet (`changePlan`'s `billImmediately: false` branch) has no UI caller
   * today. Kept optional (rather than removed) so this email still renders
   * correctly for that path if it's ever driven directly via the API.
   */
  async sendTrialEndingSoon(to: string | string[], data: {
    sellerName: string; storeName: string; daysLeft: number; trialEndsAt: Date;
    committedPlan?: { name: string; amountUSD: number };
  }) {
    const committedBox = data.committedPlan
      ? `<div class="box">
          <table role="presentation" width="100%" style="border-collapse:collapse;"><tr><td style="padding:6px 0;font-size:14px;color:#767676;text-align:left;">Plan after trial</td><td style="padding:6px 0 6px 16px;font-size:14px;font-weight:600;color:#222;text-align:right;">${data.committedPlan.name}</td></tr></table>
          <table role="presentation" width="100%" style="border-collapse:collapse;"><tr><td style="padding:6px 0;font-size:14px;color:#767676;text-align:left;">Amount to be charged</td><td style="padding:6px 0 6px 16px;font-size:14px;font-weight:600;color:#222;text-align:right;">${money(data.committedPlan.amountUSD)}</td></tr></table>
        </div>
        <p style="text-align:center;color:#666;font-size:13px;">No action needed if you want to continue — your card will be charged automatically when the trial ends.</p>`
      : `<p style="text-align:center;color:#666;font-size:13px;">Choose a plan before then to keep selling without interruption — your store's data is always safe either way.</p>`;
    const html = shell('Your trial is ending soon', `
      <p>Hi ${data.sellerName},</p>
      <p>Your free trial for <strong>${data.storeName}</strong> ends in
      <strong>${data.daysLeft} day${data.daysLeft === 1 ? '' : 's'}</strong> (${data.trialEndsAt.toDateString()}).</p>
      ${committedBox}
    `);
    await this.send(to, `Your ${data.storeName} trial ends in ${data.daysLeft} day${data.daysLeft === 1 ? '' : 's'}`, html);
  }
}
