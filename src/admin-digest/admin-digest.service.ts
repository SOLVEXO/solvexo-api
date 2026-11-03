/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { PlatformAlertsService } from '../platform-alerts/platform-alerts.service';
import { SaasMetricsService } from '../admin-analytics/saas-metrics.service';
import { ActivationFunnelService } from '../admin-analytics/activation-funnel.service';
import { MerchantHealthService } from '../admin-clients/merchant-health.service';
import { type DigestData, digestHtml, digestSubject } from './digest-email.util';

const DAY = 86_400_000;
/** The same alert isn't sent again for this long, as long as it stays active. */
const ALERT_REPEAT_SECONDS = 24 * 60 * 60;
const ALERT_SEVERITIES = new Set(['critical', 'warning']);
const appUrl = () => (process.env.FRONTEND_URL || 'https://solvexo.store').replace(/\/+$/, '');

/**
 * Keeps admins informed without opening the panel:
 *  - every 15 minutes, a newly active critical / warning platform alert is sent once (in-app, push and email, per
 *    each admin's notification preferences), and not again for 24 hours while it stays active;
 *  - every Monday 03:05 UTC (08:05 in Pakistan), a weekly business digest email.
 * Both go to active admins who can see analytics (Super Admins, and team admins with analytics.view).
 */
@Injectable()
export class AdminDigestService {
  private readonly logger = new Logger(AdminDigestService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    private readonly alerts: PlatformAlertsService,
    private readonly saas: SaasMetricsService,
    private readonly funnel: ActivationFunnelService,
    private readonly health: MerchantHealthService,
  ) {}

  /** Active admins who may see business numbers. */
  async recipients(): Promise<{ _id: string; weeklyDigest: boolean }[]> {
    const r = this.db.repositories;
    const admins: any[] = await r.adminModel.find({ isDelete: { $ne: true }, status: 'active', isVerified: true })
      .select('isSuperAdmin roleId weeklyDigest accessExpiresAt').lean();
    const roleIds = [...new Set(admins.filter((a) => !a.isSuperAdmin && a.roleId).map((a) => String(a.roleId)))];
    const roles: any[] = roleIds.length ? await r.adminRoleModel.find({ _id: { $in: roleIds }, isDelete: false }).select('permissions').lean() : [];
    const canSee = new Set(roles.filter((x) => (x.permissions ?? []).includes('analytics.view')).map((x) => String(x._id)));
    const now = Date.now();
    return admins
      .filter((a) => !(a.accessExpiresAt && new Date(a.accessExpiresAt).getTime() < now))
      // Super Admin, legacy owner (no role) or a role with analytics.view.
      .filter((a) => a.isSuperAdmin || !a.roleId || canSee.has(String(a.roleId)))
      .map((a) => ({ _id: String(a._id), weeklyDigest: a.weeklyDigest !== false }));
  }

  // ── Alerts ────────────────────────────────────────────────────────────────

  @Cron('*/15 * * * *')
  async checkAlertsJob() {
    await this.redis.withLock('cron-lock:admin-alert-notify', 10 * 60_000, async () => {
      const sent = await this.notifyNewAlerts();
      if (sent > 0) this.logger.log(`Platform alerts: ${sent} new alert(s) sent to admins`);
    });
  }

  /** Sends each active critical / warning alert that wasn't sent in the last 24 hours. Returns how many were sent. */
  async notifyNewAlerts(): Promise<number> {
    const res: any = await this.alerts.getAlerts({});
    const active = (res?.data?.alerts ?? []).filter((a: any) => ALERT_SEVERITIES.has(a.severity));
    if (active.length === 0) return 0;
    const fresh: any[] = [];
    for (const a of active) {
      const key = `admin-alert-sent:${a.id}`;
      if (await this.redis.get(key)) continue;
      fresh.push(a);
      await this.redis.set(key, '1', ALERT_REPEAT_SECONDS);
    }
    if (fresh.length === 0) return 0;
    const admins = await this.recipients();
    for (const a of fresh) {
      const title = `${a.severity === 'critical' ? 'Critical' : 'Warning'}: ${a.category}`;
      await Promise.all(admins.map((adm) => this.notifications.notify({
        recipientId: adm._id, recipientRole: 'admin', type: NOTIFICATION_TYPES.ADMIN_PLATFORM_ALERT,
        title, body: a.message, data: { link: '/admin', alertId: a.id, severity: a.severity },
      })));
    }
    return fresh.length;
  }

  // ── Weekly digest ─────────────────────────────────────────────────────────

  @Cron('5 3 * * 1')
  async weeklyDigestJob() {
    await this.redis.withLock('cron-lock:admin-weekly-digest', 30 * 60_000, async () => {
      const sent = await this.sendDigest();
      this.logger.log(`Weekly digest sent to ${sent} admin(s)`);
    });
  }

  /** Every section is loaded independently: one failing source shows "couldn't be loaded", never a missing email. */
  async collect(now = Date.now()): Promise<DigestData> {
    const r = this.db.repositories;
    const since = new Date(now - 7 * DAY);
    const [revenue, growth, health, funnel, alerts] = await Promise.allSettled([
      this.saas.weekOverWeek(now),
      Promise.all([
        r.sellerModel.countDocuments({ isDelete: { $ne: true }, createdAt: { $gte: since } }),
        r.storeModel.countDocuments({ isDelete: false, createdAt: { $gte: since } }),
      ]),
      this.health.list({ band: 'at_risk', limit: 5 }),
      this.funnel.getFunnel(2, now),
      this.alerts.getAlerts({}),
    ]);
    const ok = <T>(p: PromiseSettledResult<T>) => (p.status === 'fulfilled' ? p.value : null);
    const h: any = ok(health), f: any = ok(funnel), al: any = ok(alerts), g = ok(growth);
    return {
      periodEnd: new Date(now),
      revenue: ok(revenue),
      growth: g ? { newSellers: g[0], newStores: g[1] } : null,
      health: h ? {
        atRisk: h.data.summary.atRisk, attention: h.data.summary.attention, mrrAtRisk: h.data.summary.mrrAtRisk,
        top: h.data.items.map((x: any) => ({ storeName: x.storeName, score: x.score, reason: x.reasons[0]?.text ?? '', mrr: x.mrr })),
      } : null,
      activation: f ? {
        stuckCount: f.data.stuck.length,
        top: f.data.stuck.slice(0, 5).map((x: any) => ({ name: x.name ?? x.email ?? 'Unnamed merchant', nextStep: x.nextStep, daysStuck: x.daysStuck })),
      } : null,
      alerts: al ? (al.data.alerts as any[]).filter((a) => ALERT_SEVERITIES.has(a.severity)).map((a) => ({ severity: a.severity, category: a.category, message: a.message })) : null,
    };
  }

  async build(now = Date.now()) {
    const data = await this.collect(now);
    return { subject: digestSubject(data), html: digestHtml(data, appUrl()), data };
  }

  /** Sends the digest to every recipient who hasn't switched it off (or only to `onlyAdminId`). Returns the count. */
  async sendDigest(onlyAdminId?: string): Promise<number> {
    const admins = (await this.recipients()).filter((a) => (onlyAdminId ? a._id === onlyAdminId : a.weeklyDigest));
    if (admins.length === 0) return 0;
    const { subject, html } = await this.build();
    await Promise.all(admins.map((a) => this.notifications.notify({
      recipientId: a._id, recipientRole: 'admin', type: NOTIFICATION_TYPES.ADMIN_WEEKLY_DIGEST,
      title: 'Your weekly Solvexo summary is ready', body: subject, data: { link: '/admin' },
      email: { subject, html },
    })));
    return admins.length;
  }

  // ── Per-admin setting ─────────────────────────────────────────────────────

  async getSettings(adminId: string) {
    const admin: any = await this.db.repositories.adminModel.findById(adminId).select('weeklyDigest').lean();
    return { success: true, data: { weeklyDigest: admin?.weeklyDigest !== false } };
  }

  async updateSettings(adminId: string, weeklyDigest: boolean) {
    await this.db.repositories.adminModel.updateOne({ _id: adminId }, { $set: { weeklyDigest } });
    return { success: true, data: { weeklyDigest } };
  }
}
