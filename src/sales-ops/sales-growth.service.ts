/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import {
  type PlanInfo,
  firstPaidAt,
  liveStoreMrr,
} from '../admin-analytics/saas-metrics.util';
import { SalesLead, SalesLeadDocument } from './schemas/sales-lead.schema';
import {
  SalesActivity,
  SalesActivityDocument,
} from './schemas/sales-activity.schema';
import {
  CAMPAIGN_CHANNELS,
  SalesCampaign,
  SalesCampaignDocument,
} from './schemas/sales-campaign.schema';
import {
  SalesTarget,
  SalesTargetDocument,
} from './schemas/sales-target.schema';
import {
  SalesSettings,
  SalesSettingsDocument,
} from './schemas/sales-settings.schema';
import { SalesOpsService } from './sales-ops.service';
import type { SalesActor } from './sales-ops.util';
import {
  type LeadRow,
  type MerchantRow,
  campaignCode,
  campaignResults,
  currentMonth,
  isMonth,
  leaderboard,
  monthRange,
  normCode,
  untrackedCodes,
} from './sales-reports.util';

const CONTACT_TYPES = ['call', 'whatsapp', 'meeting', 'email'];
const SITE = process.env.PUBLIC_SITE_URL || 'https://solvexo.store';
/** Default utm_source / utm_medium per channel, so every link a campaign hands out is tagged the same way. */
const CHANNEL_UTM: Record<string, [string, string]> = {
  facebook: ['facebook', 'paid_social'],
  instagram: ['instagram', 'paid_social'],
  google: ['google', 'cpc'],
  tiktok: ['tiktok', 'paid_social'],
  youtube: ['youtube', 'video'],
  whatsapp: ['whatsapp', 'message'],
  email: ['email', 'email'],
  sms: ['sms', 'message'],
  influencer: ['influencer', 'referral'],
  event: ['event', 'offline'],
  other: ['other', 'other'],
};

export interface CampaignInput {
  name?: string;
  code?: string;
  channel?: string;
  utmSource?: string | null;
  utmMedium?: string | null;
  landingPath?: string;
  startDate?: string | null;
  endDate?: string | null;
  budgetPKR?: number | null;
  notes?: string | null;
  isArchived?: boolean;
}
export interface TargetInput {
  adminId: string;
  wonDeals?: number | null;
  wonValuePKR?: number | null;
  activities?: number | null;
}

/** Sales Ops phase 3: marketing campaigns (spend → leads → sign-ups → paying) and the sales team (assignment, targets, leaderboard). */
@Injectable()
export class SalesGrowthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly fx: ExchangeRateService,
    private readonly notifications: NotificationsService,
    private readonly sales: SalesOpsService,
    @InjectModel(SalesLead.name)
    private readonly leads: Model<SalesLeadDocument>,
    @InjectModel(SalesActivity.name)
    private readonly activities: Model<SalesActivityDocument>,
    @InjectModel(SalesCampaign.name)
    private readonly campaigns: Model<SalesCampaignDocument>,
    @InjectModel(SalesTarget.name)
    private readonly targets: Model<SalesTargetDocument>,
    @InjectModel(SalesSettings.name)
    private readonly settings: Model<SalesSettingsDocument>,
  ) {}

  // ── Campaigns ─────────────────────────────────────────────────────────────

  async listCampaigns(includeArchived = false) {
    const all: any[] = await this.campaigns
      .find(includeArchived ? {} : { isArchived: { $ne: true } })
      .sort({ createdAt: -1 })
      .lean();
    const { leads, merchants, pkrPerUSD } = await this.attributionData();
    const results = campaignResults(
      all.map((c) => this.input(c)),
      leads,
      merchants,
      pkrPerUSD,
    );
    const totals = results.reduce(
      (t, r) => ({
        spendPKR: t.spendPKR + r.spendPKR,
        leads: t.leads + r.leads,
        signups: t.signups + r.signups,
        paying: t.paying + r.paying,
        mrrUSD: t.mrrUSD + r.mrrUSD,
      }),
      { spendPKR: 0, leads: 0, signups: 0, paying: 0, mrrUSD: 0 },
    );
    return {
      success: true,
      data: {
        campaigns: results.map((r) => ({
          ...r,
          link: this.link(all.find((c) => String(c._id) === r.id)),
        })),
        totals: {
          ...totals,
          mrrUSD: Math.round(totals.mrrUSD * 100) / 100,
          costPerPayingPKR: totals.paying
            ? Math.round(totals.spendPKR / totals.paying)
            : null,
        },
        untracked: untrackedCodes(
          all.map((c) => c.code),
          leads,
          merchants,
        ).slice(0, 10),
        pkrPerUSD,
      },
    };
  }

  async getCampaign(id: string) {
    const c: any = await this.findCampaign(id);
    const { leads, merchants, pkrPerUSD } = await this.attributionData(c.code);
    const [result] = campaignResults(
      [this.input(c)],
      leads,
      merchants,
      pkrPerUSD,
    );
    const leadDocs: any[] = await this.leads
      .find({
        isDelete: false,
        'utm.campaign': new RegExp(
          `^${c.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
          'i',
        ),
      })
      .select('name businessName stage ownerAdminId sellerId createdAt')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return {
      success: true,
      data: {
        ...result,
        utmSource: c.utmSource,
        utmMedium: c.utmMedium,
        landingPath: c.landingPath,
        notes: c.notes,
        link: this.link(c),
        spend: [...(c.spend ?? [])]
          .sort((a: any, b: any) => +new Date(b.date) - +new Date(a.date))
          .map((s: any) => ({ ...s, _id: String(s._id) })),
        recentLeads: leadDocs.map((l) => ({
          _id: String(l._id),
          name: l.name,
          businessName: l.businessName,
          stage: l.stage,
          createdAt: l.createdAt,
        })),
      },
    };
  }

  async saveCampaign(
    actor: SalesActor,
    id: string | null,
    input: CampaignInput,
  ) {
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) {
      if (!input.name.trim())
        throw new BadRequestException('Give the campaign a name.');
      set.name = input.name.trim().slice(0, 120);
    }
    if (input.channel !== undefined) {
      if (!(CAMPAIGN_CHANNELS as readonly string[]).includes(input.channel))
        throw new BadRequestException('Unknown channel.');
      set.channel = input.channel;
    }
    for (const k of ['utmSource', 'utmMedium', 'notes'] as const)
      if (input[k] !== undefined)
        set[k] =
          input[k]
            ?.toString()
            .trim()
            .slice(0, k === 'notes' ? 2000 : 60) || null;
    if (input.landingPath !== undefined) {
      const p = input.landingPath.trim() || '/';
      if (!p.startsWith('/') || /\s/.test(p))
        throw new BadRequestException(
          'The landing page must be a path on solvexo.store, like /book-demo.',
        );
      set.landingPath = p.slice(0, 200);
    }
    for (const k of ['startDate', 'endDate'] as const)
      if (input[k] !== undefined) {
        const d = input[k] ? new Date(input[k]!) : null;
        if (d && Number.isNaN(d.getTime()))
          throw new BadRequestException('Invalid date.');
        set[k] = d;
      }
    if (input.budgetPKR !== undefined)
      set.budgetPKR =
        input.budgetPKR === null
          ? null
          : Math.max(0, Math.round(Number(input.budgetPKR)) || 0);
    if (input.isArchived !== undefined) set.isArchived = !!input.isArchived;
    if (input.code !== undefined || !id) {
      const code = campaignCode(input.code?.trim() || input.name || '');
      if (!code)
        throw new BadRequestException(
          'Give the campaign a link code (letters, numbers and dashes).',
        );
      const clash: any = await this.campaigns
        .findOne({ code, ...(id ? { _id: { $ne: id } } : {}) })
        .select('_id name')
        .lean();
      if (clash)
        throw new ConflictException(
          `Another campaign already uses the code “${code}” (${clash.name}).`,
        );
      set.code = code;
    }
    if (!id) {
      if (!set.name) throw new BadRequestException('Give the campaign a name.');
      const ch = (set.channel as string) ?? 'other';
      const [src, med] = CHANNEL_UTM[ch] ?? CHANNEL_UTM.other;
      const doc: any = await this.campaigns.create({
        utmSource: src,
        utmMedium: med,
        landingPath: '/book-demo',
        spend: [],
        ...set,
        channel: ch,
        createdByAdminId: actor.adminId,
      });
      return this.getCampaign(String(doc._id));
    }
    await this.findCampaign(id);
    await this.campaigns.updateOne({ _id: id }, { $set: set });
    return this.getCampaign(id);
  }

  async addSpend(
    actor: SalesActor,
    id: string,
    entry: { date: string; amountPKR: number; note?: string | null },
  ) {
    await this.findCampaign(id);
    const date = new Date(entry.date);
    const amount = Math.round(Number(entry.amountPKR));
    if (Number.isNaN(date.getTime()))
      throw new BadRequestException('Invalid date.');
    if (!(amount > 0))
      throw new BadRequestException('Enter the amount spent in PKR.');
    await this.campaigns.updateOne({ _id: id }, {
      $push: {
        spend: {
          date,
          amountPKR: amount,
          note: entry.note?.trim().slice(0, 200) || null,
          adminId: actor.adminId,
        },
      },
    } as any);
    return this.getCampaign(id);
  }

  async removeSpend(id: string, spendId: string) {
    await this.findCampaign(id);
    await this.campaigns.updateOne({ _id: id }, {
      $pull: { spend: { _id: spendId } },
    } as any);
    return this.getCampaign(id);
  }

  // ── Team ──────────────────────────────────────────────────────────────────

  async team(monthWanted?: string) {
    const month = isMonth(monthWanted) ? monthWanted : currentMonth();
    const { from, to } = monthRange(month);
    const inMonth = { $gte: from, $lt: to };
    const now = new Date();
    const [ownersRes, newLeads, acts, demoChanges, closed, open, targets] =
      await Promise.all([
        this.sales.owners(),
        this.leads
          .find({ isDelete: false, createdAt: inMonth })
          .select('ownerAdminId')
          .lean(),
        this.activities
          .find({ type: { $in: CONTACT_TYPES }, createdAt: inMonth })
          .select('adminId')
          .lean(),
        this.activities
          .find({ type: 'stage_change', 'meta.to': 'demo', createdAt: inMonth })
          .select('leadId')
          .lean(),
        this.leads
          .find({
            isDelete: false,
            $or: [
              { stage: 'won', wonAt: inMonth },
              { stage: 'lost', stageChangedAt: inMonth },
            ],
          })
          .select('ownerAdminId stage dealValuePKR')
          .lean(),
        this.leads
          .find({ isDelete: false, stage: { $nin: ['won', 'lost'] } })
          .select('ownerAdminId dealValuePKR nextFollowUpAt')
          .lean(),
        this.targets.find({ month }).lean(),
      ]);
    // A demo counts for whoever owns the lead (stage changes made by the system have no admin).
    const demoLeadIds = [
      ...new Set((demoChanges as any[]).map((d) => d.leadId)),
    ];
    const demoLeads: any[] = demoLeadIds.length
      ? await this.leads
          .find({ _id: { $in: demoLeadIds } })
          .select('ownerAdminId')
          .lean()
      : [];
    const ownerOf = new Map(
      demoLeads.map((l) => [String(l._id), l.ownerAdminId ?? null]),
    );
    const rows = leaderboard(
      ownersRes.data.map((o) => ({ adminId: o._id, name: o.name })),
      {
        newLeads: newLeads as any[],
        activities: acts as any[],
        demos: (demoChanges as any[]).map((d) => ({
          ownerAdminId: ownerOf.get(String(d.leadId)) ?? null,
        })),
        closed: closed as any[],
        open: (open as any[]).map((o) => ({
          ownerAdminId: o.ownerAdminId,
          dealValuePKR: o.dealValuePKR,
          overdue: !!o.nextFollowUpAt && new Date(o.nextFollowUpAt) < now,
        })),
      },
      (targets as any[]).map((t) => ({
        adminId: t.adminId,
        wonDeals: t.wonDeals,
        wonValuePKR: t.wonValuePKR,
        activities: t.activities,
      })),
    );
    const unassignedOpen = (open as any[]).filter(
      (o) => !o.ownerAdminId,
    ).length;
    return { success: true, data: { month, reps: rows, unassignedOpen } };
  }

  async saveTargets(actor: SalesActor, month: string, rows: TargetInput[]) {
    if (!isMonth(month)) throw new BadRequestException('Choose a month.');
    const allowed = new Set((await this.sales.owners()).data.map((o) => o._id));
    const clean = (v: number | null | undefined) =>
      v === null || v === undefined || Number.isNaN(Number(v))
        ? null
        : Math.max(0, Math.round(Number(v)));
    for (const r of rows) {
      if (!allowed.has(r.adminId)) continue;
      const t = {
        wonDeals: clean(r.wonDeals),
        wonValuePKR: clean(r.wonValuePKR),
        activities: clean(r.activities),
      };
      if (
        t.wonDeals === null &&
        t.wonValuePKR === null &&
        t.activities === null
      )
        await this.targets.deleteOne({ adminId: r.adminId, month });
      else
        await this.targets.updateOne(
          { adminId: r.adminId, month },
          { $set: { ...t, updatedByAdminId: actor.adminId } },
          { upsert: true },
        );
    }
    return this.team(month);
  }

  // ── Assignment ───────────────────────────────────────────────────────────

  async getSettings() {
    const s: any = (await this.settings.findOne({ key: 'default' }).lean()) ?? {
      autoAssign: false,
      assigneeIds: [],
    };
    return {
      success: true,
      data: { autoAssign: !!s.autoAssign, assigneeIds: s.assigneeIds ?? [] },
    };
  }

  async saveSettings(input: { autoAssign: boolean; assigneeIds: string[] }) {
    const allowed = new Set((await this.sales.owners()).data.map((o) => o._id));
    const ids = [
      ...new Set((input.assigneeIds ?? []).filter((x) => allowed.has(x))),
    ];
    if (input.autoAssign && !ids.length)
      throw new BadRequestException(
        'Choose at least one person to give new leads to.',
      );
    await this.settings.updateOne(
      { key: 'default' },
      { $set: { autoAssign: !!input.autoAssign, assigneeIds: ids } },
      { upsert: true },
    );
    return this.getSettings();
  }

  /**
   * Who gets the next lead that arrives on its own, or null when auto-assign is off. Round-robin over the chosen
   * people who are still active; the cursor moves atomically, so two leads at once go to different people.
   */
  async nextAssignee(): Promise<string | null> {
    const s: any = await this.settings
      .findOneAndUpdate(
        { key: 'default', autoAssign: true },
        { $inc: { cursor: 1 } },
        { new: false },
      )
      .lean();
    if (!s?.assigneeIds?.length) return null;
    const active = new Set((await this.sales.owners()).data.map((o) => o._id));
    const ids: string[] = s.assigneeIds.filter((x: string) => active.has(x));
    if (!ids.length) return null;
    return ids[(s.cursor ?? 0) % ids.length];
  }

  /** Tells a rep a lead was given to them automatically. */
  async notifyAssigned(
    adminId: string,
    leadId: string,
    leadName: string,
    sourceLabel: string,
  ) {
    await this.notifications
      .notify({
        recipientId: adminId,
        recipientRole: 'admin',
        type: NOTIFICATION_TYPES.ADMIN_SALES_LEAD,
        title: `New lead for you: ${leadName}`,
        body: `From ${sourceLabel}. Get in touch today.`,
        data: { link: `/admin/sales/leads/${leadId}` },
      })
      .catch(() => undefined);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private input(c: any) {
    return {
      id: String(c._id),
      code: c.code,
      name: c.name,
      channel: c.channel,
      budgetPKR: c.budgetPKR ?? null,
      startDate: c.startDate ?? null,
      endDate: c.endDate ?? null,
      isArchived: !!c.isArchived,
      spend: c.spend ?? [],
    };
  }

  private link(c: any): string | null {
    if (!c) return null;
    const q = new URLSearchParams({
      utm_source: c.utmSource || 'other',
      utm_medium: c.utmMedium || 'other',
      utm_campaign: c.code,
    });
    return `${SITE}${c.landingPath || '/'}?${q.toString()}`;
  }

  private async findCampaign(id: string) {
    if (!/^[a-f0-9]{24}$/i.test(id))
      throw new NotFoundException('Campaign not found.');
    const c = await this.campaigns.findById(id).lean();
    if (!c) throw new NotFoundException('Campaign not found.');
    return c;
  }

  /** Every lead and merchant with a campaign code (or linked to such a lead), and what each merchant went on to do. */
  private async attributionData(
    onlyCode?: string,
  ): Promise<{
    leads: LeadRow[];
    merchants: MerchantRow[];
    pkrPerUSD: number | null;
  }> {
    const r = this.db.repositories;
    const codeMatch = onlyCode
      ? new RegExp(`^${onlyCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
      : { $nin: [null, ''] };
    const [leadDocs, taggedSellers, rate]: [any[], any[], any] =
      await Promise.all([
        this.leads
          .find({ isDelete: false, 'utm.campaign': codeMatch })
          .select('utm stage sellerId dealValuePKR')
          .lean(),
        r.sellerModel
          .find({ isDelete: { $ne: true }, acquisitionCampaign: codeMatch })
          .select('acquisitionCampaign')
          .lean(),
        this.fx.getCurrentRate('PKR').catch(() => null),
      ]);
    const leads: LeadRow[] = leadDocs.map((l) => ({
      id: String(l._id),
      campaign: normCode(l.utm?.campaign),
      stage: l.stage,
      sellerId: l.sellerId ?? null,
      dealValuePKR: l.dealValuePKR,
    }));
    const campaignBySeller = new Map<string, string | null>(
      taggedSellers.map((s) => [
        String(s._id),
        normCode(s.acquisitionCampaign),
      ]),
    );
    for (const l of leads)
      if (l.sellerId && !campaignBySeller.has(l.sellerId))
        campaignBySeller.set(l.sellerId, null);
    const sellerIds = [...campaignBySeller.keys()];
    const merchants: MerchantRow[] = [];
    if (sellerIds.length) {
      const stores: any[] = await r.storeModel
        .find({ sellerId: { $in: sellerIds } })
        .select('sellerId')
        .lean();
      const sellerOfStore = new Map(
        stores.map((s) => [String(s._id), String(s.sellerId)]),
      );
      const [subs, plans]: [any[], any[]] = await Promise.all([
        stores.length
          ? r.sellerPlatformSubscriptionModel
              .find({
                storeId: { $in: [...sellerOfStore.keys()] },
                isDelete: { $ne: true },
              })
              .select(
                'storeId status platformPlanId amountUSD billingInterval startedAt trialEndsAt canceledAt lockedAt gracePeriodEndsAt updatedAt planHistory',
              )
              .lean()
          : [],
        r.platformPlanModel
          .find({})
          .select('isFree monthlyPriceUSD yearlyPriceUSD gracePeriodDays')
          .lean(),
      ]);
      const planMap = new Map<string, PlanInfo>(
        plans.map((p) => [String(p._id), p]),
      );
      const agg = new Map<
        string,
        { trialed: boolean; paid: boolean; mrrUSD: number }
      >();
      for (const s of subs) {
        const sellerId = sellerOfStore.get(String(s.storeId));
        if (!sellerId) continue;
        const a = agg.get(sellerId) ?? {
          trialed: false,
          paid: false,
          mrrUSD: 0,
        };
        a.trialed ||= s.status === 'trialing' || !!s.trialEndsAt;
        a.paid ||= firstPaidAt(s, planMap) !== null;
        a.mrrUSD += liveStoreMrr(s);
        agg.set(sellerId, a);
      }
      for (const id of sellerIds) {
        const a = agg.get(id) ?? { trialed: false, paid: false, mrrUSD: 0 };
        merchants.push({
          sellerId: id,
          campaign: campaignBySeller.get(id) ?? null,
          ...a,
          paid: a.paid || a.mrrUSD > 0,
        });
      }
    }
    return { leads, merchants, pkrPerUSD: rate?.ratePerUSD ?? null };
  }
}
