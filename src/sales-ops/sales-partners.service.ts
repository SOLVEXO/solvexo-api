/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { liveStoreMrr } from '../admin-analytics/saas-metrics.util';
import { SalesLead, SalesLeadDocument } from './schemas/sales-lead.schema';
import {
  PARTNER_KINDS,
  PAYOUT_METHODS,
  SalesPartner,
  SalesPartnerDocument,
} from './schemas/sales-partner.schema';
import {
  SalesCommissionPlan,
  SalesCommissionPlanDocument,
} from './schemas/sales-commission-plan.schema';
import {
  SalesPartnerReferral,
  SalesPartnerReferralDocument,
} from './schemas/sales-partner-referral.schema';
import {
  SalesCommission,
  SalesCommissionDocument,
} from './schemas/sales-commission.schema';
import {
  SalesPayout,
  SalesPayoutDocument,
} from './schemas/sales-payout.schema';
import {
  type InvoiceRow,
  type PlanRules,
  payableAt,
  plannedRows,
  statement,
} from './commission.util';
import { currentMonth, isMonth, monthRange } from './sales-reports.util';
import type { SalesActor } from './sales-ops.util';
import { PartnerOnboardingService } from './partner-onboarding.service';
import { EmailService } from '../otp/services/email.service';
import { SalesCaptureService } from './sales-capture.service';

const SITE = process.env.PUBLIC_SITE_URL || 'https://solvexo.store';
const isId = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s);
const clean = (v: unknown, max = 200) =>
  typeof v === 'string' ? v.trim().slice(0, max) || null : null;
export const normPartnerCode = (s: string | null | undefined) =>
  (s ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 40) || null;

export interface PartnerInput {
  name?: string;
  kind?: string;
  code?: string;
  adminId?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  planId?: string | null;
  payoutMethod?: string;
  payoutDetails?: string | null;
  status?: 'active' | 'paused';
  whtPercent?: number | null;
  notes?: string | null;
}
export interface PlanInput {
  name?: string;
  description?: string | null;
  bountyPKR?: number | null;
  percent?: number | null;
  percentMonths?: number | null;
  tiers?: { minPaying: number; percent: number }[];
  holdDays?: number;
  minPayoutPKR?: number;
  isArchived?: boolean;
}

/**
 * Sales Ops phase 4: partners (sales reps, resellers, outside agents), their commission plans, the commission ledger
 * built from Solvexo's own plan invoices, payouts and monthly statements, and each partner's own view of it.
 */
@Injectable()
export class SalesPartnersService {
  private readonly logger = new Logger(SalesPartnersService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly fx: ExchangeRateService,
    @InjectModel(SalesLead.name)
    private readonly leads: Model<SalesLeadDocument>,
    @InjectModel(SalesPartner.name)
    private readonly partners: Model<SalesPartnerDocument>,
    @InjectModel(SalesCommissionPlan.name)
    private readonly plans: Model<SalesCommissionPlanDocument>,
    @InjectModel(SalesPartnerReferral.name)
    private readonly referrals: Model<SalesPartnerReferralDocument>,
    @InjectModel(SalesCommission.name)
    private readonly ledger: Model<SalesCommissionDocument>,
    @InjectModel(SalesPayout.name)
    private readonly payouts: Model<SalesPayoutDocument>,
    private readonly programme: PartnerOnboardingService,
    private readonly email: EmailService,
    private readonly capture: SalesCaptureService,
  ) {}

  // ── Plans ────────────────────────────────────────────────────────────────

  async listPlans() {
    const rows: any[] = await this.plans
      .find({})
      .sort({ isArchived: 1, createdAt: 1 })
      .lean();
    const counts = await this.partners.aggregate([
      { $group: { _id: '$planId', n: { $sum: 1 } } },
    ]);
    const used = new Map(counts.map((c: any) => [c._id, c.n]));
    return {
      success: true,
      data: rows.map((p) => ({
        ...this.planView(p),
        partners: used.get(String(p._id)) ?? 0,
      })),
    };
  }

  async savePlan(id: string | null, input: PlanInput) {
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) {
      if (!input.name?.trim())
        throw new BadRequestException('Give the plan a name.');
      set.name = input.name.trim().slice(0, 80);
    }
    if (input.description !== undefined)
      set.description = clean(input.description, 500);
    const num = (v: unknown, k: string, max: number) => {
      if (v === null) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > max)
        throw new BadRequestException(`${k} must be between 0 and ${max}.`);
      return n;
    };
    if (input.bountyPKR !== undefined)
      set.bountyPKR = num(input.bountyPKR, 'The one-time amount', 10_000_000);
    if (input.percent !== undefined)
      set.percent = num(input.percent, 'The percentage', 100);
    if (input.percentMonths !== undefined)
      set.percentMonths =
        input.percentMonths === null
          ? null
          : Math.round(num(input.percentMonths, 'Months', 120)!);
    if (input.holdDays !== undefined)
      set.holdDays = Math.round(num(input.holdDays, 'Hold days', 180) ?? 0);
    if (input.minPayoutPKR !== undefined)
      set.minPayoutPKR = Math.round(
        num(input.minPayoutPKR, 'Minimum payout', 10_000_000) ?? 0,
      );
    if (input.tiers !== undefined)
      set.tiers = (input.tiers ?? [])
        .slice(0, 10)
        .map((t) => ({
          minPaying: Math.round(num(t.minPaying, 'Tier size', 100_000)!),
          percent: num(t.percent, 'Tier percentage', 100)!,
        }))
        .sort((a, b) => a.minPaying - b.minPaying);
    if (input.isArchived !== undefined) set.isArchived = !!input.isArchived;
    const merged = { ...(id ? await this.findPlan(id) : {}), ...set } as any;
    if (
      !(
        (merged.bountyPKR ?? 0) > 0 ||
        (merged.percent ?? 0) > 0 ||
        (merged.tiers ?? []).some((t: any) => t.percent > 0)
      )
    )
      throw new BadRequestException(
        'A plan needs a one-time amount, a percentage, or both.',
      );
    if (!id) {
      if (!set.name) throw new BadRequestException('Give the plan a name.');
      await this.plans.create({
        percentMonths: 12,
        holdDays: 14,
        minPayoutPKR: 0,
        tiers: [],
        ...set,
      });
    } else await this.plans.updateOne({ _id: id }, { $set: set });
    return this.listPlans();
  }

  // ── Partners ─────────────────────────────────────────────────────────────

  async listPartners() {
    const [rows, plans, refs, sums]: [any[], any[], any[], any[]] =
      await Promise.all([
        this.partners.find({}).sort({ status: 1, name: 1 }).lean(),
        this.plans.find({}).select('name').lean(),
        this.referrals.find({}).select('partnerId sellerId').lean(),
        this.ledger.aggregate([
          { $match: { status: { $ne: 'void' } } },
          {
            $group: {
              _id: { p: '$partnerId', s: '$status' },
              amount: { $sum: '$amountPKR' },
            },
          },
        ]),
      ]);
    const planName = new Map(plans.map((p) => [String(p._id), p.name]));
    const paying = await this.payingSellers(refs.map((r) => r.sellerId));
    const totals = (pid: string, status: string) =>
      sums
        .filter((x) => x._id.p === pid && x._id.s === status)
        .reduce((s, x) => s + x.amount, 0);
    return {
      success: true,
      data: rows.map((p) => {
        const id = String(p._id);
        const mine = refs.filter((r) => r.partnerId === id);
        return {
          ...this.partnerView(p),
          planName: p.planId ? (planName.get(p.planId) ?? null) : null,
          referred: mine.length,
          payingNow: mine.filter((r) => paying.has(r.sellerId)).length,
          pendingPKR: totals(id, 'pending'),
          payablePKR: totals(id, 'payable'),
          paidPKR: totals(id, 'paid'),
        };
      }),
    };
  }

  async getPartner(id: string) {
    const p: any = await this.findPartner(id);
    return { success: true, data: await this.partnerDetail(p, true) };
  }

  async savePartner(actor: SalesActor, id: string | null, input: PartnerInput) {
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) {
      if (!input.name?.trim())
        throw new BadRequestException('Add the partner’s name.');
      set.name = input.name.trim().slice(0, 120);
    }
    if (input.kind !== undefined) {
      if (!(PARTNER_KINDS as readonly string[]).includes(input.kind))
        throw new BadRequestException('Unknown partner type.');
      set.kind = input.kind;
    }
    if (input.payoutMethod !== undefined) {
      if (!(PAYOUT_METHODS as readonly string[]).includes(input.payoutMethod))
        throw new BadRequestException('Unknown payout method.');
      set.payoutMethod = input.payoutMethod;
    }
    for (const k of ['email', 'phone', 'city'] as const)
      if (input[k] !== undefined) set[k] = clean(input[k], 160);
    if (input.payoutDetails !== undefined)
      set.payoutDetails = clean(input.payoutDetails, 500);
    if (input.notes !== undefined) set.notes = clean(input.notes, 2000);
    if (input.whtPercent !== undefined) {
      const w = input.whtPercent === null || (input.whtPercent as unknown) === '' ? null : Number(input.whtPercent);
      if (w !== null && (!Number.isFinite(w) || w < 0 || w > 50)) throw new BadRequestException('Withholding tax must be between 0 and 50%.');
      set.whtPercent = w;
    }
    if (input.status !== undefined)
      set.status = input.status === 'paused' ? 'paused' : 'active';
    if (input.planId !== undefined) {
      if (
        input.planId &&
        !(await this.plans
          .findOne({
            _id: isId(input.planId) ? input.planId : null,
            isArchived: { $ne: true },
          })
          .lean())
      )
        throw new BadRequestException('Choose an active commission plan.');
      set.planId = input.planId || null;
    }
    if (input.adminId !== undefined) {
      if (input.adminId) {
        if (
          !isId(input.adminId) ||
          !(await this.db.repositories.adminModel
            .findById(input.adminId)
            .select('_id')
            .lean())
        )
          throw new BadRequestException('That login was not found.');
        const taken: any = await this.partners
          .findOne({
            adminId: input.adminId,
            ...(id ? { _id: { $ne: id } } : {}),
          })
          .select('name')
          .lean();
        if (taken)
          throw new ConflictException(
            `That login already belongs to partner ${taken.name}.`,
          );
      }
      set.adminId = input.adminId || null;
    }
    if (input.code !== undefined || !id) {
      const code =
        normPartnerCode(input.code) ??
        (await this.freeCode(String(set.name ?? input.name ?? 'P')));
      const clash: any = await this.partners
        .findOne({ code, ...(id ? { _id: { $ne: id } } : {}) })
        .select('name')
        .lean();
      if (clash)
        throw new ConflictException(
          `The code ${code} already belongs to ${clash.name}.`,
        );
      set.code = code;
    }
    if (!id) {
      if (!set.name) throw new BadRequestException('Add the partner’s name.');
      const doc: any = await this.partners.create({
        kind: 'agent',
        payoutMethod: 'bank',
        status: 'active',
        ...set,
        createdByAdminId: actor.adminId,
      });
      return this.getPartner(String(doc._id));
    }
    await this.findPartner(id);
    await this.partners.updateOne({ _id: id }, { $set: set });
    return this.getPartner(id);
  }

  /** Credit a merchant to a partner by hand (overrides any automatic credit). Payments from `effectiveFrom` count. */
  async setReferral(
    actor: SalesActor,
    partnerId: string,
    input: {
      sellerEmail?: string;
      sellerId?: string;
      effectiveFrom?: string | null;
    },
  ) {
    await this.findPartner(partnerId);
    const r = this.db.repositories;
    const seller: any =
      input.sellerId && isId(input.sellerId)
        ? await r.sellerModel
            .findById(input.sellerId)
            .select('createdAt')
            .lean()
        : input.sellerEmail
          ? await r.sellerModel
              .findOne({
                email: input.sellerEmail.trim().toLowerCase(),
                isDelete: { $ne: true },
              })
              .select('createdAt')
              .lean()
          : null;
    if (!seller)
      throw new NotFoundException('No merchant account with that email.');
    const from = input.effectiveFrom
      ? new Date(input.effectiveFrom)
      : new Date(seller.createdAt);
    if (Number.isNaN(from.getTime()))
      throw new BadRequestException('Invalid date.');
    await this.referrals.updateOne(
      { sellerId: String(seller._id) },
      {
        $set: {
          partnerId,
          source: 'manual',
          effectiveFrom: from,
          createdByAdminId: actor.adminId,
        },
      },
      { upsert: true },
    );
    await this.runFor([partnerId]);
    return this.getPartner(partnerId);
  }

  async removeReferral(partnerId: string, sellerId: string) {
    await this.referrals.deleteOne({ partnerId, sellerId });
    return this.getPartner(partnerId);
  }

  /** A one-off line: a bonus (positive) or a deduction (negative), payable straight away. */
  async addAdjustment(
    actor: SalesActor,
    partnerId: string,
    input: { amountPKR: number; description: string },
  ) {
    await this.findPartner(partnerId);
    const amount = Math.round(Number(input.amountPKR));
    if (!amount)
      throw new BadRequestException('Enter an amount (negative to deduct).');
    if (!input.description?.trim())
      throw new BadRequestException('Say what it is for.');
    const now = new Date();
    await this.ledger.create({
      partnerId,
      sellerId: '-',
      type: 'adjustment',
      key: `manual:${now.getTime()}:${Math.random().toString(36).slice(2, 8)}`,
      description: input.description.trim().slice(0, 200),
      amountPKR: amount,
      earnedAt: now,
      payableAt: now,
      status: 'payable',
      createdByAdminId: actor.adminId,
    });
    return this.getPartner(partnerId);
  }

  /** Pay everything payable now. The total must reach the plan's minimum payout. */
  async recordPayout(
    actor: SalesActor,
    partnerId: string,
    input: {
      method?: string;
      reference?: string | null;
      paidAt?: string | null;
      note?: string | null;
    },
  ) {
    const p: any = await this.findPartner(partnerId);
    await this.mature();
    const rows: any[] = await this.ledger
      .find({ partnerId, status: 'payable' })
      .select('_id amountPKR')
      .lean();
    const amount = rows.reduce((s, r) => s + r.amountPKR, 0);
    if (amount <= 0)
      throw new BadRequestException(
        'Nothing is payable to this partner right now.',
      );
    const plan: any = p.planId
      ? await this.plans.findById(p.planId).lean()
      : null;
    const settings = await this.programme.settings();
    const minPayout = plan?.minPayoutPKR || settings.minPayoutPKR || 0;
    if (minPayout && amount < minPayout)
      throw new BadRequestException(
        `The payable balance (PKR ${amount.toLocaleString('en-PK')}) is below the minimum payout of PKR ${minPayout.toLocaleString('en-PK')}.`,
      );
    // B4.7: withholding tax where the law requires it (the partner's own rate, else the programme default).
    const whtPercent = p.whtPercent ?? settings.withholdingTaxPercent ?? 0;
    const whtPKR = Math.round((amount * whtPercent) / 100);
    const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime()))
      throw new BadRequestException('Invalid date.');
    const method =
      input.method &&
      (PAYOUT_METHODS as readonly string[]).includes(input.method)
        ? input.method
        : p.payoutMethod;
    const payout: any = await this.payouts.create({
      partnerId,
      amountPKR: amount,
      whtPercent,
      whtPKR,
      netPKR: amount - whtPKR,
      method,
      reference: clean(input.reference, 120),
      paidAt,
      commissionIds: rows.map((r) => String(r._id)),
      note: clean(input.note, 500),
      createdByAdminId: actor.adminId,
    });
    await this.ledger.updateMany(
      { _id: { $in: rows.map((r) => r._id) }, status: 'payable' },
      { $set: { status: 'paid', payoutId: String(payout._id) } },
    );
    return this.getPartner(partnerId);
  }

  async statementFor(partnerId: string, month?: string) {
    await this.findPartner(partnerId);
    return { success: true, data: await this.buildStatement(partnerId, month) };
  }

  /** Logins a partner can be linked to (name, email, role), and which partner already uses each. */
  async logins() {
    const r = this.db.repositories;
    const [admins, roles, linked]: [any[], any[], any[]] = await Promise.all([
      r.adminModel
        .find({ isDelete: { $ne: true } })
        .select('name email roleId status isSuperAdmin')
        .sort({ name: 1 })
        .lean(),
      r.adminRoleModel.find({}).select('name').lean(),
      this.partners
        .find({ adminId: { $ne: null } })
        .select('adminId name')
        .lean(),
    ]);
    const roleName = new Map(roles.map((x) => [String(x._id), x.name]));
    const partnerOf = new Map(linked.map((x) => [x.adminId, x.name]));
    return {
      success: true,
      data: admins.map((a) => ({
        _id: String(a._id),
        name: a.name,
        email: a.email,
        status: a.status ?? 'active',
        roleName: a.isSuperAdmin
          ? 'Super Admin'
          : a.roleId
            ? (roleName.get(String(a.roleId)) ?? null)
            : 'Full access',
        partnerName: partnerOf.get(String(a._id)) ?? null,
      })),
    };
  }

  // ── The partner's own view ─────────────────────────────────────────────────

  async me(actor: SalesActor, month?: string) {
    const p: any = await this.partners
      .findOne({ adminId: actor.adminId })
      .lean();
    if (!p) return { success: true, data: null };
    const detail = await this.partnerDetail(p, false);
    return {
      success: true,
      data: {
        ...detail,
        statement: await this.buildStatement(String(p._id), month),
      },
    };
  }

  async myStatement(actor: SalesActor, month?: string) {
    const p: any = await this.partners
      .findOne({ adminId: actor.adminId })
      .select('_id')
      .lean();
    if (!p) throw new ForbiddenException('You are not set up as a partner.');
    return {
      success: true,
      data: await this.buildStatement(String(p._id), month),
    };
  }

  // ── The engine ───────────────────────────────────────────────────────────

  @Cron('30 5 * * *') // 10:30 in Pakistan, after the night's renewals
  async dailyJob() {
    await this.redis.withLock(
      'cron-lock:sales-commissions',
      20 * 60_000,
      async () => {
        const r = await this.run();
        if (r.created)
          this.logger.log(
            `Sales Ops: ${r.created} commission line(s) written, ${r.attributed} merchant(s) credited`,
          );
      },
    );
  }

  /** Credit new merchants to partners, write commission lines for new payments and refunds, release held amounts. */
  async run() {
    const attributed = await this.attribute();
    const res = await this.runFor(null);
    const matured = await this.mature();
    return { success: true, attributed, ...res, matured };
  }

  /** Who gets credit, in order: the partner's link at sign-up, the partner's code on a demo request, then the rep who owned the lead. */
  async attribute(): Promise<number> {
    const r = this.db.repositories;
    const active: any[] = await this.partners
      .find({})
      .select('code adminId')
      .lean();
    if (!active.length) return 0;
    const byCode = new Map(active.map((p) => [p.code, String(p._id)]));
    const byAdmin = new Map(
      active.filter((p) => p.adminId).map((p) => [p.adminId, String(p._id)]),
    );
    const credited = new Set(
      (await this.referrals.find({}).select('sellerId').lean()).map(
        (x: any) => x.sellerId,
      ),
    );
    const sellerCreated = new Map<string, Date>();
    let n = 0;
    const credit = async (
      sellerId: string,
      partnerId: string,
      source: string,
    ) => {
      if (credited.has(sellerId)) return;
      let from = sellerCreated.get(sellerId);
      if (!from) {
        const s: any = await r.sellerModel
          .findById(sellerId)
          .select('createdAt')
          .lean();
        if (!s) return;
        from = new Date(s.createdAt);
      }
      try {
        await this.referrals.create({
          sellerId,
          partnerId,
          source,
          effectiveFrom: from,
        });
        credited.add(sellerId);
        n++;
      } catch {
        /* already credited */
      }
    };
    const coded: any[] = await r.sellerModel
      .find({
        isDelete: { $ne: true },
        acquisitionPartnerCode: { $in: [...byCode.keys()] },
      })
      .select('acquisitionPartnerCode createdAt')
      .lean();
    for (const s of coded) {
      sellerCreated.set(String(s._id), new Date(s.createdAt));
      await credit(
        String(s._id),
        byCode.get(s.acquisitionPartnerCode)!,
        'code',
      );
    }
    const linked: any[] = await this.leads
      .find({ isDelete: false, sellerId: { $ne: null } })
      .select('sellerId partnerId ownerAdminId')
      .lean();
    for (const l of linked)
      if (l.partnerId) await credit(l.sellerId, l.partnerId, 'demo_form');
    for (const l of linked)
      if (l.ownerAdminId && byAdmin.has(l.ownerAdminId))
        await credit(l.sellerId, byAdmin.get(l.ownerAdminId)!, 'lead_owner');
    return n;
  }

  /** Writes new ledger lines for the given partners (all when null). Idempotent. */
  async runFor(
    partnerIds: string[] | null,
  ): Promise<{ created: number; skipped?: string }> {
    const rate: any = await this.fx.getCurrentRate('PKR').catch(() => null);
    const pkrPerUSD = rate?.ratePerUSD ?? null;
    if (!pkrPerUSD)
      return {
        created: 0,
        skipped:
          'Add a PKR exchange rate in FX Settings so payments can be converted to PKR.',
      };
    const ps: any[] = await this.partners
      .find({
        status: 'active',
        planId: { $ne: null },
        ...(partnerIds ? { _id: { $in: partnerIds } } : {}),
      })
      .lean();
    if (!ps.length) return { created: 0 };
    const plans = new Map(
      (
        await this.plans
          .find({ _id: { $in: ps.map((p) => p.planId).filter(isId) } })
          .lean()
      ).map((p: any) => [String(p._id), p]),
    );
    const refs: any[] = await this.referrals
      .find({ partnerId: { $in: ps.map((p) => String(p._id)) } })
      .lean();
    if (!refs.length) return { created: 0 };
    const invoices: any[] = await this.db.repositories.platformPlanInvoiceModel
      .find({
        sellerId: { $in: refs.map((x) => x.sellerId) },
        isDelete: { $ne: true },
        status: { $in: ['paid', 'partially_refunded', 'refunded'] },
        paidAt: { $ne: null },
      })
      .select(
        'storeId sellerId invoiceNumber amountUSD subtotalUSD taxAmountUSD refundedAmountUSD status paidAt paymentMethodType',
      )
      .lean();
    const paying = await this.payingSellers(refs.map((x) => x.sellerId));
    const settings = await this.programme.settings();
    const cardFee =
      settings.cardFeePercent !== null || settings.cardFeeFixedUSD !== null
        ? { percent: settings.cardFeePercent ?? 0, fixedUSD: settings.cardFeeFixedUSD ?? 0, from: new Date(settings.cardFeeFrom ?? 0) }
        : null;
    const now = new Date();
    let created = 0;
    for (const p of ps) {
      const plan: any = plans.get(p.planId);
      if (!plan) continue;
      const rules: PlanRules = {
        bountyPKR: plan.bountyPKR,
        percent: plan.percent,
        percentMonths: plan.percentMonths ?? null,
        tiers: plan.tiers ?? [],
        holdDays: plan.holdDays ?? 14,
        cardFee,
      };
      const pid = String(p._id);
      const mine = refs.filter((x) => x.partnerId === pid);
      const payingNow = mine.filter((x) => paying.has(x.sellerId)).length;
      const existing: any[] = await this.ledger
        .find({
          partnerId: pid,
          type: { $in: ['bounty', 'percent', 'adjustment', 'activation'] },
          sellerId: { $in: mine.map((x) => x.sellerId) },
        })
        .select('key type invoiceId amountPKR pkrPerUSD percent')
        .lean();
      for (const ref of mine) {
        const invs: InvoiceRow[] = invoices
          .filter((i) => i.sellerId === ref.sellerId)
          .map((i) => ({
            ...i,
            id: String(i._id),
            subtotalUSD: i.subtotalUSD ?? null,
            taxAmountUSD: i.taxAmountUSD ?? 0,
            refundedAmountUSD: i.refundedAmountUSD ?? 0,
          }));
        const rows = plannedRows({
          plan: rules,
          invoices: invs,
          effectiveFrom: new Date(ref.effectiveFrom),
          payingNow,
          existing: existing.map((e) => ({
            key: e.key,
            type: e.type,
            invoiceId: e.invoiceId,
            amountPKR: e.amountPKR,
          })),
          rateFor: () => pkrPerUSD,
          existingRate: (invoiceId) => {
            const e = existing.find((x) => x.key === `pct:${invoiceId}`);
            return e ? { pkrPerUSD: e.pkrPerUSD, percent: e.percent } : null;
          },
          commissionEndsAt: ref.commissionEndsAt ? new Date(ref.commissionEndsAt) : null,
          activation: settings.activationBonusPKR ? { amountPKR: settings.activationBonusPKR, sellerPayingNow: paying.has(ref.sellerId), now } : null,
        });
        for (const row of rows) {
          // A clawback is due straight away; earnings wait out the refund window.
          const due =
            row.type === 'adjustment'
              ? now
              : payableAt(row.earnedAt, rules.holdDays);
          try {
            await this.ledger.create({
              partnerId: pid,
              ...row,
              payableAt: due,
              status: due <= now ? 'payable' : 'pending',
            });
            created++;
          } catch {
            /* written by a parallel run */
          }
        }
      }
    }
    return { created };
  }

  /**
   * B4.4: the partner stopped supporting this seller. Written notice is recorded; commission on the seller's payments
   * ends `supportNoticeDays` later. `cancel` withdraws the notice.
   */
  async supportNotice(actor: SalesActor, partnerId: string, sellerId: string, input: { reason?: string; cancel?: boolean }) {
    const p: any = await this.findPartner(partnerId);
    const ref: any = await this.referrals.findOne({ partnerId, sellerId }).lean();
    if (!ref) throw new NotFoundException('This merchant is not credited to this partner.');
    if (input.cancel) {
      await this.referrals.updateOne({ _id: ref._id }, { $set: { supportNoticeAt: null, supportNoticeReason: null, commissionEndsAt: null } });
      return this.getPartner(partnerId);
    }
    const reason = clean(input.reason, 500);
    if (!reason) throw new BadRequestException('Give the reason: it is sent to the partner in writing.');
    const s = await this.programme.settings();
    const at = new Date();
    const ends = new Date(at.getTime() + s.supportNoticeDays * 86_400_000);
    await this.referrals.updateOne({ _id: ref._id }, { $set: { supportNoticeAt: at, supportNoticeReason: reason, commissionEndsAt: ends } });
    const names = await this.merchantNames([sellerId]);
    if (p.email) {
      void this.email.sendMail(p.email, 'Notice: commission on a seller is ending', `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1c1d1b"><p>Hi ${escapeHtml(p.name)},</p>
        <p>This is written notice under the partner programme (B4.4) that commission on <strong>${escapeHtml(names.get(sellerId) ?? 'a seller')}</strong> ends on <strong>${ends.toISOString().slice(0, 10)}</strong>, because: ${escapeHtml(reason)}</p>
        <p>Commission already earned is not affected. Reply to this email if you think this is a mistake.</p></div>`).catch(() => false);
    }
    this.logger.log(`Support notice for seller ${sellerId} of partner ${partnerId} by ${actor.adminId}`);
    return this.getPartner(partnerId);
  }

  /**
   * B4.5: on the statement day each partner with activity gets last month's statement by email and managers get the
   * payouts due by the payout day; the day after the payout day, unpaid balances are flagged. Each runs once a month.
   */
  @Cron('50 5 * * *')
  async monthlyStatements() {
    await this.redis.withLock('partner-statements', 600_000, async () => { await this.runStatements(new Date()); });
  }

  async runStatements(now: Date) {
    const s = await this.programme.settings();
    const pk = new Date(now.getTime() + 5 * 3_600_000); // Pakistan time
    const day = pk.getUTCDate();
    const thisMonth = pk.toISOString().slice(0, 7);
    const prev = new Date(Date.UTC(pk.getUTCFullYear(), pk.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const ps: any[] = await this.partners.find({ status: 'active' }).lean();
    let sent = 0;
    let flagged = 0;
    if (day >= s.statementDay) {
      await this.mature();
      const due: string[] = [];
      for (const p of ps) {
        if (p.statementSentFor === prev) continue;
        const st = await this.buildStatement(String(p._id), prev);
        const payable = await this.payableBalance(String(p._id));
        const active = st.earnedPKR !== 0 || st.paidPKR !== 0 || st.openingPKR !== 0;
        if (active && p.email) {
          void this.email.sendMail(p.email, `Your Solvexo partner statement for ${prev}`, this.statementEmail(p, prev, st, payable, s)).catch(() => false);
          sent++;
        }
        if (payable > 0) due.push(`${p.name}: PKR ${payable.toLocaleString('en-PK')}`);
        await this.partners.updateOne({ _id: p._id }, { $set: { statementSentFor: prev } });
      }
      if (due.length) void this.capture.notifyManagers(`Partner payouts due by the ${s.payoutDay}th`, due.slice(0, 8).join(' · ') + (due.length > 8 ? ` · and ${due.length - 8} more` : ''), null);
    }
    if (day > s.payoutDay) {
      const late: string[] = [];
      for (const p of ps) {
        if (p.payoutOverdueFlaggedFor === thisMonth) continue;
        const payable = await this.payableBalance(String(p._id));
        const paidThisMonth = await this.payouts.exists({ partnerId: String(p._id), paidAt: { $gte: new Date(`${thisMonth}-01T00:00:00+05:00`) } });
        if (payable > 0 && !paidThisMonth) { late.push(`${p.name}: PKR ${payable.toLocaleString('en-PK')}`); flagged++; }
        await this.partners.updateOne({ _id: p._id }, { $set: { payoutOverdueFlaggedFor: thisMonth } });
      }
      if (late.length) void this.capture.notifyManagers('Partner payouts overdue', `Past the ${s.payoutDay}th and not paid: ${late.slice(0, 8).join(' · ')}${late.length > 8 ? ` · and ${late.length - 8} more` : ''}`, null);
    }
    return { sent, flagged };
  }

  private async payableBalance(partnerId: string) {
    const rows: any[] = await this.ledger.find({ partnerId, status: 'payable' }).select('amountPKR').lean();
    return rows.reduce((t, r) => t + r.amountPKR, 0);
  }

  private statementEmail(p: any, month: string, st: { openingPKR: number; earnedPKR: number; paidPKR: number; closingPKR: number }, payable: number, s: { payoutDay: number; withholdingTaxPercent: number | null }) {
    const pkr = (n: number) => `PKR ${n.toLocaleString('en-PK')}`;
    const wht = p.whtPercent ?? s.withholdingTaxPercent;
    return `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1c1d1b"><h2 style="color:#D97757">Statement for ${month}</h2>
      <p>Hi ${escapeHtml(p.name)}, here is your commission statement.</p>
      <table style="border-collapse:collapse;font-size:14px">
        <tr><td style="padding:4px 12px 4px 0">Owed at the start of the month</td><td align="right">${pkr(st.openingPKR)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0">Earned in the month</td><td align="right">${pkr(st.earnedPKR)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0">Paid in the month</td><td align="right">${pkr(st.paidPKR)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><strong>Owed at the end of the month</strong></td><td align="right"><strong>${pkr(st.closingPKR)}</strong></td></tr>
      </table>
      <p>${payable > 0 ? `${pkr(payable)} is payable now and will be paid by the ${s.payoutDay}th${wht ? `, less ${wht}% withholding tax` : ''}.` : 'Nothing is payable yet: amounts are held for the refund window first.'}</p>
      <p>The full statement is on your partner page under My earnings.</p></div>`;
  }

  /** Held amounts whose refund window has passed become payable. */
  async mature(): Promise<number> {
    const r: any = await this.ledger.updateMany(
      { status: 'pending', payableAt: { $lte: new Date() } },
      { $set: { status: 'payable' } },
    );
    return r?.modifiedCount ?? 0;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async buildStatement(partnerId: string, monthWanted?: string) {
    const month = isMonth(monthWanted) ? monthWanted : currentMonth();
    const { from, to } = monthRange(month);
    const [rows, pays]: [any[], any[]] = await Promise.all([
      this.ledger
        .find({ partnerId })
        .select('amountPKR earnedAt status type description sellerId payableAt')
        .lean(),
      this.payouts
        .find({ partnerId })
        .select('amountPKR paidAt method reference')
        .lean(),
    ]);
    const totals = statement(
      rows.map((x) => ({ ...x, earnedAt: new Date(x.earnedAt) })),
      pays.map((x) => ({ amountPKR: x.amountPKR, paidAt: new Date(x.paidAt) })),
      from,
      to,
    );
    const inMonth = rows
      .filter(
        (x) =>
          x.status !== 'void' &&
          new Date(x.earnedAt) >= from &&
          new Date(x.earnedAt) < to,
      )
      .sort((a, b) => +new Date(a.earnedAt) - +new Date(b.earnedAt));
    const names = await this.merchantNames(inMonth.map((x) => x.sellerId));
    return {
      month,
      ...totals,
      lines: inMonth.map((x) => ({
        _id: String(x._id),
        earnedAt: x.earnedAt,
        type: x.type,
        description: x.description,
        merchant: names.get(x.sellerId) ?? null,
        amountPKR: x.amountPKR,
        status: x.status,
        payableAt: x.payableAt,
      })),
      payouts: pays
        .filter((x) => new Date(x.paidAt) >= from && new Date(x.paidAt) < to)
        .map((x) => ({
          _id: String(x._id),
          amountPKR: x.amountPKR,
          paidAt: x.paidAt,
          method: x.method,
          reference: x.reference,
        })),
    };
  }

  private async partnerDetail(p: any, forManager: boolean) {
    const id = String(p._id);
    const [plan, refs, lines, pays]: [any, any[], any[], any[]] =
      await Promise.all([
        p.planId && isId(p.planId)
          ? this.plans.findById(p.planId).lean()
          : null,
        this.referrals.find({ partnerId: id }).sort({ createdAt: -1 }).lean(),
        this.ledger
          .find({ partnerId: id })
          .sort({ earnedAt: -1 })
          .limit(200)
          .lean(),
        this.payouts
          .find({ partnerId: id })
          .sort({ paidAt: -1 })
          .limit(50)
          .lean(),
      ]);
    const allLines: any[] = await this.ledger
      .find({ partnerId: id, status: { $ne: 'void' } })
      .select('amountPKR status')
      .lean();
    const sum = (s: string) =>
      allLines
        .filter((x) => x.status === s)
        .reduce((t, x) => t + x.amountPKR, 0);
    const paying = await this.payingSellers(refs.map((x) => x.sellerId));
    const names = await this.merchantNames([
      ...refs.map((x) => x.sellerId),
      ...lines.map((x) => x.sellerId),
    ]);
    const earnedBy = new Map<string, number>();
    const earnedRows: any[] = await this.ledger.aggregate([
      { $match: { partnerId: id, status: { $ne: 'void' } } },
      { $group: { _id: '$sellerId', amount: { $sum: '$amountPKR' } } },
    ]);
    for (const e of earnedRows) earnedBy.set(e._id, e.amount);
    const view = this.partnerView(p, forManager);
    return {
      partner: view,
      link: `${SITE}/?partner=${encodeURIComponent(p.code)}`,
      plan: plan ? this.planView(plan) : null,
      balances: {
        pendingPKR: sum('pending'),
        payablePKR: sum('payable'),
        paidPKR: sum('paid'),
        earnedPKR: sum('pending') + sum('payable') + sum('paid'),
      },
      referrals: refs.map((x) => ({
        sellerId: x.sellerId,
        merchant: names.get(x.sellerId) ?? 'Merchant',
        source: x.source,
        effectiveFrom: x.effectiveFrom,
        payingNow: paying.has(x.sellerId),
        earnedPKR: earnedBy.get(x.sellerId) ?? 0,
        supportNoticeAt: x.supportNoticeAt ?? null,
        commissionEndsAt: x.commissionEndsAt ?? null,
      })),
      lines: lines.map((x) => ({
        _id: String(x._id),
        earnedAt: x.earnedAt,
        payableAt: x.payableAt,
        type: x.type,
        description: x.description,
        merchant: names.get(x.sellerId) ?? null,
        amountPKR: x.amountPKR,
        status: x.status,
      })),
      payouts: pays.map((x) => ({
        _id: String(x._id),
        amountPKR: x.amountPKR,
        paidAt: x.paidAt,
        method: x.method,
        reference: x.reference,
        whtPKR: x.whtPKR ?? 0,
        netPKR: x.netPKR ?? x.amountPKR,
        note: forManager ? x.note : undefined,
      })),
    };
  }

  /** Store names (or the seller's name) for display; a partner never sees a merchant's email or phone. */
  private async merchantNames(sellerIds: string[]) {
    const ids = [...new Set(sellerIds.filter(isId))];
    if (!ids.length) return new Map<string, string>();
    const r = this.db.repositories;
    const [sellers, stores]: [any[], any[]] = await Promise.all([
      r.sellerModel
        .find({ _id: { $in: ids } })
        .select('name')
        .lean(),
      r.storeModel
        .find({ sellerId: { $in: ids }, isDelete: { $ne: true } })
        .select('sellerId name')
        .sort({ createdAt: 1 })
        .lean(),
    ]);
    const out = new Map<string, string>(
      sellers.map((s) => [String(s._id), s.name ?? 'Merchant']),
    );
    // Prefer the merchant's first store name (stores are sorted oldest first).
    const named = new Set<string>();
    for (const st of stores) {
      const sid = String(st.sellerId);
      if (out.has(sid) && !named.has(sid) && st.name) {
        out.set(sid, st.name);
        named.add(sid);
      }
    }
    return out;
  }

  /** Merchants paying Solvexo right now (any store with live MRR). */
  /** Also used by the partner scorecard. */
  async payingSellers(sellerIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(sellerIds)];
    if (!ids.length) return new Set();
    const r = this.db.repositories;
    const stores: any[] = await r.storeModel
      .find({ sellerId: { $in: ids } })
      .select('sellerId')
      .lean();
    if (!stores.length) return new Set();
    const sellerOf = new Map(
      stores.map((s) => [String(s._id), String(s.sellerId)]),
    );
    const subs: any[] = await r.sellerPlatformSubscriptionModel
      .find({ storeId: { $in: [...sellerOf.keys()] }, isDelete: { $ne: true } })
      .select('storeId status amountUSD billingInterval')
      .lean();
    return new Set(
      subs
        .filter((s) => liveStoreMrr(s) > 0)
        .map((s) => sellerOf.get(String(s.storeId))!)
        .filter(Boolean),
    );
  }

  private async freeCode(name: string) {
    const base =
      name
        .toUpperCase()
        .replace(/[^A-Z]/g, '')
        .slice(0, 5) || 'P';
    for (let i = 0; i < 20; i++) {
      const code = `${base}${Math.floor(100 + Math.random() * 900)}`;
      if (!(await this.partners.findOne({ code }).select('_id').lean()))
        return code;
    }
    return `${base}${Date.now().toString(36).toUpperCase()}`;
  }

  private partnerView(p: any, forManager = true) {
    const base = {
      _id: String(p._id),
      name: p.name,
      kind: p.kind,
      code: p.code,
      adminId: p.adminId ?? null,
      email: p.email ?? null,
      phone: p.phone ?? null,
      city: p.city ?? null,
      planId: p.planId ?? null,
      payoutMethod: p.payoutMethod,
      payoutDetails: p.payoutDetails ?? null,
      status: p.status,
      whtPercent: p.whtPercent ?? null,
      suspendedAt: p.suspendedAt ?? null,
      suspendReason: p.suspendReason ?? null,
      /** Channel Partner Programme stage; null = set up before the programme (treated as live). */
      stage: p.stage ?? null,
      tier: p.tier ?? null,
      createdAt: p.createdAt,
    };
    return forManager ? { ...base, notes: p.notes ?? null } : base;
  }

  private planView(p: any) {
    return {
      _id: String(p._id),
      name: p.name,
      description: p.description ?? null,
      bountyPKR: p.bountyPKR ?? null,
      percent: p.percent ?? null,
      percentMonths: p.percentMonths === undefined ? 12 : p.percentMonths,
      tiers: p.tiers ?? [],
      holdDays: p.holdDays ?? 14,
      minPayoutPKR: p.minPayoutPKR ?? 0,
      isArchived: !!p.isArchived,
    };
  }

  private async findPartner(id: string) {
    if (!isId(id)) throw new NotFoundException('Partner not found.');
    const p = await this.partners.findById(id).lean();
    if (!p) throw new NotFoundException('Partner not found.');
    return p;
  }

  private async findPlan(id: string) {
    if (!isId(id)) throw new NotFoundException('Plan not found.');
    const p = await this.plans.findById(id).lean();
    if (!p) throw new NotFoundException('Plan not found.');
    return p;
  }
}

function escapeHtml(s: string) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
