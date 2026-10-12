/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { EmailService } from '../otp/services/email.service';
import { AnalyticsService } from './analytics.service';
import { AnalyticsReportsService, REPORT_EXPORT_SECTIONS } from './analytics-reports.service';

const MAX_PER_RUN = 200;
const PRESETS = ['7d', '30d', '90d', '6m', '12m'];

const escapeHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Emails a store's saved analytics reports on their schedule (weekly = Monday, monthly = the 1st, UTC), as a PDF or CSV
 * attachment built by the SAME export code the Analytics page uses. Driven by a daily cron in SchedulerService.
 */
@Injectable()
export class ScheduledReportsService {
  private readonly logger = new Logger(ScheduledReportsService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly emailService: EmailService,
    private readonly analytics: AnalyticsService,
    private readonly reports: AnalyticsReportsService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  /** Which schedules fire today (UTC): weekly on Monday, monthly on the 1st. */
  static dueSchedules(now: Date): Array<'weekly' | 'monthly'> {
    const due: Array<'weekly' | 'monthly'> = [];
    if (now.getUTCDay() === 1) due.push('weekly');
    if (now.getUTCDate() === 1) due.push('monthly');
    return due;
  }

  async processDue(now = new Date()): Promise<{ sent: number; failed: number }> {
    const schedules = ScheduledReportsService.dueSchedules(now);
    if (schedules.length === 0) return { sent: 0, failed: 0 };

    // Not already sent today (a re-run of the job, or a second instance, must never double-send).
    const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const notSentToday = [{ lastSentAt: null }, { lastSentAt: { $lt: startOfToday } }];
    const due: any[] = await this.r.savedReportModel
      .find({ schedule: { $in: schedules }, $or: notSentToday })
      .limit(MAX_PER_RUN)
      .lean();

    let sent = 0;
    let failed = 0;
    for (const report of due) {
      const previous: Date | null = report.lastSentAt ?? null;
      // Claim first (conditional update), so only one instance sends; undo the claim if the send fails.
      const claim = await this.r.savedReportModel.updateOne(
        { _id: report._id, schedule: report.schedule, $or: notSentToday },
        { $set: { lastSentAt: now } },
      );
      if (claim.modifiedCount === 0) continue;
      try {
        const ok = await this.sendOne(report, now);
        if (ok) sent += 1;
        else { failed += 1; await this.r.savedReportModel.updateOne({ _id: report._id }, { $set: { lastSentAt: previous } }); }
      } catch (err: any) {
        failed += 1;
        this.logger.warn(`Scheduled report ${report._id} failed: ${err?.message ?? err}`);
        await this.r.savedReportModel.updateOne({ _id: report._id }, { $set: { lastSentAt: previous } });
      }
    }
    return { sent, failed };
  }

  private async sendOne(report: any, now: Date): Promise<boolean> {
    const store: any = await this.r.storeModel.findById(report.storeId).select('name status isDelete').lean();
    const seller: any = await this.r.sellerModel.findById(report.sellerId).select('name email isDelete').lean();
    // A deleted/suspended store or a deleted seller no longer gets reports; turn the schedule off instead of retrying forever.
    if (!store || store.isDelete || (store.status ?? 'active') !== 'active' || !seller || seller.isDelete || !seller.email) {
      await this.r.savedReportModel.updateOne({ _id: report._id }, { $set: { schedule: 'none' } });
      return true;
    }

    const cfg = report.config ?? {};
    const range = PRESETS.includes(cfg.range) ? cfg.range : report.schedule === 'monthly' ? '30d' : '7d';
    const query: any = { range, storeId: report.storeId, compareToPreviousPeriod: !!cfg.compareToPreviousPeriod, section: cfg.section ?? undefined };

    let attachment: { filename: string; content: Buffer | string; contentType: string };
    const safeName = String(report.name).replace(/[^\w.-]+/g, '-').slice(0, 60) || 'report';
    if (cfg.format === 'pdf') {
      attachment = { filename: `${safeName}.pdf`, content: await this.analytics.exportPdf(report.sellerId, report.storeId, query), contentType: 'application/pdf' };
    } else {
      const csv = (REPORT_EXPORT_SECTIONS as readonly string[]).includes(cfg.section ?? '')
        ? await this.reports.exportCsv(report.sellerId, report.storeId, query)
        : await this.analytics.exportCsv(report.sellerId, report.storeId, query);
      attachment = { filename: `${safeName}.csv`, content: csv, contentType: 'text/csv' };
    }

    const frontend = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
    const link = frontend ? `${frontend}/store/${report.storeId}/analytics` : '';
    const html = `<div style="font-family:sans-serif;max-width:520px">
      <p>Hi ${escapeHtml(seller.name ?? 'there')},</p>
      <p>Your <strong>${escapeHtml(report.name)}</strong> report for <strong>${escapeHtml(store.name ?? 'your store')}</strong> is attached
      (${report.schedule}, last ${escapeHtml(range)}, generated ${now.toISOString().slice(0, 10)}).</p>
      ${link ? `<p><a href="${link}">Open Analytics</a> — you can change or turn off this email under Saved Reports.</p>` : ''}
    </div>`;
    return this.emailService.sendMail(seller.email, `${report.name} — ${store.name ?? 'Store'} analytics report`, html, null, undefined, [attachment]);
  }
}
