/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { SalesPartnersService } from './sales-partners.service';
import { PartnerOnboardingService } from './partner-onboarding.service';
import { SalesPartner, SalesPartnerDocument } from './schemas/sales-partner.schema';
import { SalesPartnerReferral, SalesPartnerReferralDocument } from './schemas/sales-partner-referral.schema';
import { SalesCommission, SalesCommissionDocument } from './schemas/sales-commission.schema';
import { PartnerDeal, PartnerDealDocument } from './schemas/partner-deal.schema';
import { PARTNER_LOG_TYPES, PartnerLog, PartnerLogDocument } from './schemas/partner-log.schema';
import { type ScoreInput, type SellerFacts, monthlyTrend, pilotMilestones, scorecard } from './partner-scorecard.util';
import type { PartnerTier } from './partner-programme.util';
import type { SalesActor } from './sales-ops.util';

const isId = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s);
const clean = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) || null : null);
/** Partners that are actually selling: onboarding, live, or set up before the programme. */
const SELLING = { $or: [{ stage: { $in: ['onboarding', 'live'] } }, { stage: null }, { stage: { $exists: false } }] };

/** Channel Partner Programme B13: scorecards, leaderboard, monthly reviews, QBRs and complaints. */
@Injectable()
export class PartnerScorecardService {
  constructor(
    private readonly db: DatabaseService,
    private readonly commissions: SalesPartnersService,
    private readonly onboarding: PartnerOnboardingService,
    @InjectModel(SalesPartner.name) private readonly partners: Model<SalesPartnerDocument>,
    @InjectModel(SalesPartnerReferral.name) private readonly referrals: Model<SalesPartnerReferralDocument>,
    @InjectModel(SalesCommission.name) private readonly ledger: Model<SalesCommissionDocument>,
    @InjectModel(PartnerDeal.name) private readonly deals: Model<PartnerDealDocument>,
    @InjectModel(PartnerLog.name) private readonly logs: Model<PartnerLogDocument>,
  ) {}

  async leaderboard() {
    const ps: any[] = await this.partners.find(SELLING).lean();
    const inputs = await this.inputs(ps);
    const s = await this.onboarding.settings();
    const rows = ps.map((p) => {
      const input = inputs.get(String(p._id))!;
      const card = scorecard(input, s);
      return {
        _id: String(p._id), name: p.name, tier: (p.tier ?? null) as PartnerTier | null, territory: p.territory ?? null, stage: p.stage ?? 'live',
        status: p.status, ...card, milestones: p.agreement?.pilotEndsAt && new Date(p.agreement.pilotEndsAt).getTime() > Date.now() ? pilotMilestones(card, s) : null,
      };
    });
    rows.sort((a, b) => b.payingNow - a.payingNow || b.liveStores - a.liveStores || b.prospects - a.prospects);
    return { success: true, data: rows };
  }

  async detail(id: string) {
    const p = await this.find(id);
    return { success: true, data: await this.view(p, true) };
  }

  async mine(actor: SalesActor) {
    const p: any = await this.partners.findOne({ adminId: actor.adminId }).lean();
    if (!p) return { success: true, data: null };
    return { success: true, data: await this.view(p, false) };
  }

  async addLog(actor: SalesActor, id: string, input: { type?: string; summary?: string; details?: string; plan?: string; about?: string; at?: string; visibleToPartner?: boolean }) {
    const p = await this.find(id);
    const type = input.type ?? '';
    if (!['monthly_review', 'qbr', 'complaint', 'note'].includes(type)) {
      if ((PARTNER_LOG_TYPES as readonly string[]).includes(type)) throw new BadRequestException('Warnings, improvement plans and suspensions have their own actions.');
      throw new BadRequestException('Unknown entry type.');
    }
    const summary = clean(input.summary, 300);
    if (!summary) throw new BadRequestException('Add a short summary.');
    const at = input.at ? new Date(input.at) : new Date();
    if (isNaN(at.getTime())) throw new BadRequestException('That date is not valid.');
    // Reviews keep the numbers that were discussed.
    const snapshot = type === 'monthly_review' || type === 'qbr'
      ? scorecard((await this.inputs([p])).get(String(p._id))!, await this.onboarding.settings())
      : null;
    await this.logs.create({
      partnerId: String(p._id), type, at, by: actor.adminId, summary, details: clean(input.details, 4000), plan: clean(input.plan, 4000),
      about: clean(input.about, 200), snapshot: snapshot as unknown as Record<string, unknown> | null,
      // Complaints and internal notes stay internal unless a manager chooses otherwise; reviews are shared.
      visibleToPartner: input.visibleToPartner ?? (type === 'monthly_review' || type === 'qbr'),
    });
    return this.detail(id);
  }

  async resolveComplaint(id: string, logId: string) {
    const p = await this.find(id);
    if (!isId(logId)) throw new NotFoundException('Entry not found.');
    const r = await this.logs.updateOne({ _id: logId, partnerId: String(p._id), type: 'complaint', resolvedAt: null }, { $set: { resolvedAt: new Date() } });
    if (!r.matchedCount) throw new NotFoundException('Open complaint not found.');
    return this.detail(id);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async view(p: any, forManager: boolean) {
    const input = (await this.inputs([p])).get(String(p._id))!;
    const s = await this.onboarding.settings();
    const card = scorecard(input, s);
    const logs: any[] = await this.logs.find({ partnerId: String(p._id), ...(forManager ? {} : { visibleToPartner: true }) }).sort({ at: -1 }).limit(200).lean();
    const lastReview = logs.find((l) => l.type === 'monthly_review');
    const lastQbr = logs.find((l) => l.type === 'qbr');
    const DAY = 86_400_000;
    return {
      partner: { _id: String(p._id), name: p.name, tier: p.tier ?? null, territory: p.territory ?? null, stage: p.stage ?? 'live', agreement: p.agreement ?? null },
      scorecard: card,
      milestones: pilotMilestones(card, s),
      milestonesApproved: ['pilotMinPayingSellers', 'pilotMinLiveStores', 'pilotMaxComplaintRatePercent'].every((k) => s.approvedKeys.includes(k)),
      trend: monthlyTrend(input),
      reviews: {
        lastMonthlyAt: lastReview?.at ?? null, monthlyDue: !lastReview || Date.now() - new Date(lastReview.at).getTime() > 31 * DAY,
        lastQbrAt: lastQbr?.at ?? null, qbrDue: !lastQbr || Date.now() - new Date(lastQbr.at).getTime() > 92 * DAY,
      },
      log: logs.map((l) => ({
        _id: String(l._id), type: l.type, at: l.at, summary: l.summary, details: l.details ?? null, plan: l.plan ?? null,
        about: forManager || l.type !== 'complaint' ? (l.about ?? null) : null, resolvedAt: l.resolvedAt ?? null, dueAt: l.dueAt ?? null,
        snapshot: l.snapshot ?? null, visibleToPartner: !!l.visibleToPartner,
      })),
    };
  }

  /** Everything the scorecard needs, for many partners in a few queries. */
  private async inputs(ps: any[]): Promise<Map<string, ScoreInput>> {
    const ids = ps.map((p) => String(p._id));
    const r = this.db.repositories;
    const now = new Date();
    const [refs, deals, complaints, earned]: [any[], any[], any[], any[]] = await Promise.all([
      this.referrals.find({ partnerId: { $in: ids } }).select('partnerId sellerId createdAt').lean(),
      this.deals.find({ partnerId: { $in: ids } }).select('partnerId submittedAt status extensions extensionRequest').lean(),
      this.logs.find({ partnerId: { $in: ids }, type: 'complaint' }).select('partnerId at').lean(),
      this.ledger.aggregate([{ $match: { partnerId: { $in: ids }, status: { $ne: 'void' } } }, { $group: { _id: '$partnerId', amount: { $sum: '$amountPKR' } } }]),
    ]);
    const sellerIds = [...new Set(refs.map((x) => x.sellerId))];
    const [paying, invoices, stores]: [Set<string>, any[], any[]] = await Promise.all([
      this.commissions.payingSellers(sellerIds),
      sellerIds.length ? r.platformPlanInvoiceModel.aggregate([
        { $match: { sellerId: { $in: sellerIds }, isDelete: { $ne: true }, status: { $in: ['paid', 'partially_refunded', 'refunded'] }, paidAt: { $ne: null } } },
        { $group: { _id: '$sellerId', first: { $min: '$paidAt' } } },
      ]) : Promise.resolve([]),
      sellerIds.length ? r.storeModel.find({ sellerId: { $in: sellerIds }, isDelete: { $ne: true }, status: 'active' }).select('_id sellerId').lean() : Promise.resolve([]),
    ]);
    const counts: any[] = stores.length ? await r.productModel.aggregate([
      { $match: { storeId: { $in: stores.map((x) => String(x._id)) }, isDelete: false, status: 'active' } },
      { $group: { _id: '$storeId', n: { $sum: 1 } } },
    ]) : [];
    const liveStoreIds = new Set(counts.filter((c) => c.n >= 5).map((c) => String(c._id)));
    const liveSellers = new Set(stores.filter((x) => liveStoreIds.has(String(x._id))).map((x) => String(x.sellerId)));
    const firstPaid = new Map(invoices.map((x) => [String(x._id), new Date(x.first)]));
    const earnedBy = new Map(earned.map((x) => [x._id, x.amount]));
    const out = new Map<string, ScoreInput>();
    for (const p of ps) {
      const id = String(p._id);
      const sellers: SellerFacts[] = refs.filter((x) => x.partnerId === id).map((x) => ({
        sellerId: x.sellerId, creditedAt: new Date(x.createdAt), firstPaidAt: firstPaid.get(x.sellerId) ?? null,
        payingNow: paying.has(x.sellerId), liveStore: liveSellers.has(x.sellerId),
      }));
      out.set(id, {
        now, startedAt: p.agreement?.signedAt ? new Date(p.agreement.signedAt) : (p.createdAt ? new Date(p.createdAt) : null), sellers,
        registrations: deals.filter((d) => d.partnerId === id).map((d) => ({
          submittedAt: new Date(d.submittedAt), status: d.status,
          demoHeld: (d.extensions ?? []).some((e: any) => e.progress === 'demo_held') || d.extensionRequest?.progress === 'demo_held',
        })),
        complaints: complaints.filter((c) => c.partnerId === id).map((c) => new Date(c.at)),
        certifiedStaff: (p.staff ?? []).filter((x: any) => x.certifiedAt).length,
        tier: (p.tier ?? null) as PartnerTier | null,
        earnedPKR: earnedBy.get(id) ?? 0,
      });
    }
    return out;
  }

  private async find(id: string): Promise<any> {
    if (!isId(id)) throw new NotFoundException('Partner not found.');
    const p = await this.partners.findById(id).lean();
    if (!p) throw new NotFoundException('Partner not found.');
    return p;
  }
}
