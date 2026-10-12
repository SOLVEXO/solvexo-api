/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { emailEvents, EmailResultEvent, EmailService } from '@/otp/services/email.service';
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
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private lastAlertAt = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
    private readonly emailService: EmailService,
  ) {}

  onModuleInit() {
    emailEvents.on('result', (e: EmailResultEvent) => {
      if (!e.ok) this.lastError = e.error ?? null; // synchronous, so sendTest() can read the reason right after a failed send
      void this.record(e);
    });
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async record(e: EmailResultEvent) {
    try {
      const update: Record<string, any> = e.ok
        ? { $inc: { sent: 1 } }
        : { $inc: { failed: 1 }, $set: { lastError: e.error ?? 'Unknown error', lastErrorAt: new Date() } };
      await this.db.repositories.emailDailyStatModel.updateOne({ date: this.today() }, update, { upsert: true });
    } catch (err: any) {
      this.logger.warn(`Could not record email stat: ${err?.message}`);
    }

    if (e.ok) { this.consecutiveFailures = 0; return; }
    this.consecutiveFailures += 1;
    this.lastError = e.error ?? null;
    const due = this.consecutiveFailures === ALERT_AFTER_FAILURES || (this.consecutiveFailures > ALERT_AFTER_FAILURES && Date.now() - this.lastAlertAt > ALERT_EVERY_MS);
    if (!due) return;
    this.lastAlertAt = Date.now();
    await this.notifications.notifyAdmins({
      type: NOTIFICATION_TYPES.ADMIN_EMAIL_FAILURE,
      title: 'Emails are failing to send',
      body: `The last ${this.consecutiveFailures} emails could not be sent (OTP, order and billing emails are affected). Last error: ${this.lastError ?? 'unknown'}. Check the SMTP settings.`,
      data: { link: '/admin/settings?tab=email' },
    });
  }

  /** Settings + the last 14 days — never returns the SMTP password. */
  async getHealth() {
    const days: { date: string; sent: number; failed: number }[] = [];
    const rows: any[] = await this.db.repositories.emailDailyStatModel.find({}).sort({ date: -1 }).limit(14).lean();
    const byDate = new Map(rows.map((r) => [r.date, r]));
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      const r = byDate.get(d);
      days.push({ date: d, sent: r?.sent ?? 0, failed: r?.failed ?? 0 });
    }
    const lastFailed = rows.find((r) => r.lastError);
    return {
      success: true,
      data: {
        configured: !!(process.env.SMTP_USER && process.env.SMTP_PASSWORD),
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT as string) || 587,
        from: process.env.SMTP_FROM || process.env.SMTP_USER || null,
        appName: process.env.APP_NAME || null,
        consecutiveFailures: this.consecutiveFailures,
        lastError: lastFailed?.lastError ?? null,
        lastErrorAt: lastFailed?.lastErrorAt ?? null,
        totals: { sent: days.reduce((n, d) => n + d.sent, 0), failed: days.reduce((n, d) => n + d.failed, 0) },
        days,
      },
    };
  }

  /** Verifies the SMTP login and sends one real test mail to the calling admin. */
  async sendTest(adminId: string) {
    const admin: any = await this.db.repositories.adminModel.findById(adminId).select('email').lean();
    if (!admin?.email) return { success: false, message: 'Your admin account has no email address.' };
    this.lastError = null;
    const connected = await this.emailService.testConnection();
    if (!connected) return { success: false, message: 'Could not log in to the SMTP server. Check SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASSWORD.' };
    const ok = await this.emailService.sendMail(
      admin.email,
      `${process.env.APP_NAME || 'Solvexo'} test email`,
      `<p>This is a test email from the ${process.env.APP_NAME || 'Solvexo'} admin panel. If you can read it, platform email works.</p>`,
    );
    return ok
      ? { success: true, message: `Test email sent to ${admin.email}.` }
      : { success: false, message: `The test email could not be sent${this.lastError ? `: ${this.lastError}` : '.'}` };
  }
}
