/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { escapeEmailText, solvexoEmail } from './templates/notification-email.template';
import { DatabaseService } from '@/database/databaseservice';
import { emailEvents, EmailChannel, EmailResultEvent, EmailService, marketingSmtpConfig } from '@/otp/services/email.service';
import { NotificationsService } from './notifications.service';
import { NOTIFICATION_TYPES } from './notification.types';

const ALERT_AFTER_FAILURES = 5;
const ALERT_EVERY_MS = 60 * 60 * 1000;

/**
 * Platform email health for the admin: counts every send attempt per day, remembers the last SMTP error, and tells
 * the admins (in-app — an email alert would fail too) when emails keep failing in a row.
 */
@Injectable()
export class EmailHealthService implements OnModuleInit {
  private readonly logger = new Logger(EmailHealthService.name);
  /** Kept per sender, so failing campaigns never raise the "sign-up and order emails are failing" alarm, and back. */
  private readonly state: Record<EmailChannel, { consecutiveFailures: number; lastError: string | null; lastAlertAt: number }> = {
    transactional: { consecutiveFailures: 0, lastError: null, lastAlertAt: 0 },
    marketing: { consecutiveFailures: 0, lastError: null, lastAlertAt: 0 },
  };

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
    private readonly emailService: EmailService,
  ) {}

  onModuleInit() {
    emailEvents.on('result', (e: EmailResultEvent) => {
      if (!e.ok) this.state[e.channel ?? 'transactional'].lastError = e.error ?? null; // synchronous, so sendTest() can read the reason right after a failed send
      void this.record(e);
    });
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async record(e: EmailResultEvent) {
    const channel: EmailChannel = e.channel ?? 'transactional';
    const mk = channel === 'marketing';
    try {
      const update: Record<string, any> = e.ok
        ? { $inc: { [mk ? 'marketingSent' : 'sent']: 1 } }
        : {
            $inc: { [mk ? 'marketingFailed' : 'failed']: 1 },
            $set: { [mk ? 'marketingLastError' : 'lastError']: e.error ?? 'Unknown error', [mk ? 'marketingLastErrorAt' : 'lastErrorAt']: new Date() },
          };
      await this.db.repositories.emailDailyStatModel.updateOne({ date: this.today() }, update, { upsert: true });
    } catch (err: any) {
      this.logger.warn(`Could not record email stat: ${err?.message}`);
    }

    const st = this.state[channel];
    if (e.ok) { st.consecutiveFailures = 0; return; }
    st.consecutiveFailures += 1;
    st.lastError = e.error ?? null;
    const due = st.consecutiveFailures === ALERT_AFTER_FAILURES || (st.consecutiveFailures > ALERT_AFTER_FAILURES && Date.now() - st.lastAlertAt > ALERT_EVERY_MS);
    if (!due) return;
    st.lastAlertAt = Date.now();
    await this.notifications.notifyAdmins({
      type: NOTIFICATION_TYPES.ADMIN_EMAIL_FAILURE,
      title: mk ? 'Marketing emails are failing to send' : 'Emails are failing to send',
      body: mk
        ? `The last ${st.consecutiveFailures} marketing emails could not be sent (campaigns, newsletters, automations and abandoned-cart emails). Sign-up codes and order emails are not affected. Last error: ${st.lastError ?? 'unknown'}. Check the MARKETING_SMTP settings.`
        : `The last ${st.consecutiveFailures} emails could not be sent (OTP, order and billing emails are affected). Last error: ${st.lastError ?? 'unknown'}. Check the SMTP settings.`,
      data: { link: '/admin/settings?tab=email' },
    });
  }

  /** Settings + the last 14 days — never returns the SMTP password. */
  async getHealth() {
    const days: { date: string; sent: number; failed: number; marketingSent: number; marketingFailed: number }[] = [];
    const rows: any[] = await this.db.repositories.emailDailyStatModel.find({}).sort({ date: -1 }).limit(14).lean();
    const byDate = new Map(rows.map((r) => [r.date, r]));
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      const r = byDate.get(d);
      days.push({ date: d, sent: r?.sent ?? 0, failed: r?.failed ?? 0, marketingSent: r?.marketingSent ?? 0, marketingFailed: r?.marketingFailed ?? 0 });
    }
    const lastFailed = rows.find((r) => r.lastError);
    const lastMarketingFailed = rows.find((r) => r.marketingLastError);
    const m = marketingSmtpConfig();
    return {
      success: true,
      data: {
        configured: !!(process.env.SMTP_USER && process.env.SMTP_PASSWORD),
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT as string) || 587,
        from: process.env.SMTP_FROM || process.env.SMTP_USER || null,
        appName: process.env.APP_NAME || null,
        consecutiveFailures: this.state.transactional.consecutiveFailures,
        lastError: lastFailed?.lastError ?? null,
        lastErrorAt: lastFailed?.lastErrorAt ?? null,
        totals: { sent: days.reduce((n, d) => n + d.sent, 0), failed: days.reduce((n, d) => n + d.failed, 0) },
        days,
        // The dedicated marketing sender (never its password). Not configured = bulk mail still uses the platform sender.
        marketing: {
          configured: !!m,
          host: m?.host ?? null,
          port: m?.port ?? null,
          from: m?.from ?? null,
          consecutiveFailures: this.state.marketing.consecutiveFailures,
          lastError: lastMarketingFailed?.marketingLastError ?? null,
          lastErrorAt: lastMarketingFailed?.marketingLastErrorAt ?? null,
          totals: { sent: days.reduce((n, d) => n + d.marketingSent, 0), failed: days.reduce((n, d) => n + d.marketingFailed, 0) },
        },
      },
    };
  }

  /** Verifies the sender's login and sends one real test mail to the calling admin (the platform or the marketing sender). */
  async sendTest(adminId: string, channel: EmailChannel = 'transactional') {
    const admin: any = await this.db.repositories.adminModel.findById(adminId).select('email').lean();
    if (!admin?.email) return { success: false, message: 'Your admin account has no email address.' };
    const mk = channel === 'marketing';
    if (mk && !this.emailService.hasMarketingSender())
      return { success: false, message: 'The marketing sender is not set up. Set MARKETING_SMTP_HOST, MARKETING_SMTP_USER, MARKETING_SMTP_PASSWORD and MARKETING_SMTP_FROM on the server.' };
    this.state[channel].lastError = null;
    const connected = await this.emailService.testConnection(channel);
    if (!connected)
      return {
        success: false,
        message: mk
          ? 'Could not log in to the marketing SMTP server. Check MARKETING_SMTP_HOST, MARKETING_SMTP_PORT, MARKETING_SMTP_USER and MARKETING_SMTP_PASSWORD.'
          : 'Could not log in to the SMTP server. Check SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASSWORD.',
      };
    const app = process.env.APP_NAME || 'Solvexo';
    const from = marketingSmtpConfig()?.from ?? process.env.SMTP_FROM ?? '';
    // A marketing test is sent the way bulk mail is: with List-Unsubscribe, which is what routes it to the marketing sender.
    const ok = await this.emailService.sendMail(
      admin.email,
      `${app} ${mk ? 'marketing ' : ''}test email`,
      solvexoEmail(
        `${app} ${mk ? 'marketing ' : ''}test email`,
        `<div class="success">This is a test email from the ${escapeEmailText(app)} admin panel. If you can read it, ${mk ? 'marketing email (campaigns, newsletters, automations)' : 'platform email'} works.</div>`,
        { note: null },
      ),
      null,
      mk ? { 'List-Unsubscribe': `<mailto:${from}?subject=unsubscribe>` } : undefined,
    );
    const reason = this.lastErrorOf(channel); // set by the result listener during sendMail()
    return ok
      ? { success: true, message: `Test email sent to ${admin.email}.` }
      : { success: false, message: `The test email could not be sent${reason ? `: ${reason}` : '.'}` };
  }

  private lastErrorOf(channel: EmailChannel): string | null {
    return this.state[channel].lastError;
  }
}
