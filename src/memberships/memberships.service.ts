import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { AccessPlan, AccessPlanDocument, MemberSubscription, MemberSubscriptionDocument } from './membership.schema';
import { accessUntil, addInterval, dunningDecision, prorationCredit, upgradeAmountDue, REMINDER_DAYS_BEFORE, type PlanInterval } from './membership.util';
import { SUBSCRIPTION_PROVIDERS } from './subscription-provider';

const LIVE = ['trialing', 'active', 'past_due', 'paused'];
const DAY = 86_400_000;

export interface RenewalEvent { kind: 'reminder' | 'payment_failed' | 'grace' | 'cancelled' | 'expired'; subscriptionId: string; storeId: string; customerId: string }

const audit = (action: string, by: string, note = '') => ({ at: new Date(), action, by, note });

@Injectable()
export class MembershipsService {
  constructor(
    private readonly db: DatabaseService,
    @InjectModel(AccessPlan.name) readonly planModel: Model<AccessPlanDocument>,
    @InjectModel(MemberSubscription.name) readonly subModel: Model<MemberSubscriptionDocument>,
  ) {}

  // ---------------- plans (seller) ----------------

  private cleanPlan(b: any, currency: string) {
    const name = String(b?.name ?? '').trim();
    if (!name) throw new BadRequestException('Plan name is required');
    const type = b?.type;
    if (!['free', 'one_time', 'recurring'].includes(type)) throw new BadRequestException('type must be free, one_time or recurring');
    const amount = type === 'free' ? 0 : Number(b?.amount);
    if (!Number.isFinite(amount) || amount < 0 || (type !== 'free' && amount <= 0)) throw new BadRequestException('amount must be greater than 0');
    const interval = b?.interval ?? 'month';
    if (!['week', 'month', 'year'].includes(interval)) throw new BadRequestException('Invalid interval');
    const int = (v: any, min: number, max: number, d: number) => {
      if (v === undefined || v === null || v === '') return d;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) throw new BadRequestException(`Value must be a whole number between ${min} and ${max}`);
      return n;
    };
    return {
      name: name.slice(0, 80),
      description: String(b?.description ?? '').slice(0, 1000),
      type,
      amount: Math.round(amount * 100) / 100,
      currency,
      interval,
      intervalCount: int(b?.intervalCount, 1, 12, 1),
      trialDays: type === 'recurring' ? int(b?.trialDays, 0, 365, 0) : 0,
      fixedLength: type === 'recurring' && b?.fixedLength ? int(b.fixedLength, 1, 120, 1) : null,
      pauseAllowed: !!b?.pauseAllowed,
      benefits: (Array.isArray(b?.benefits) ? b.benefits : []).map((x: any) => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 20),
      tier: int(b?.tier, 1, 100, 1),
      graceDays: int(b?.graceDays, 0, 7, 0),
    };
  }

  private async storeCurrency(storeId: string): Promise<string> {
    const s: any = await this.db.repositories.storeModel.findOne({ _id: storeId, isDelete: false }).select('baseCurrency').lean();
    if (!s) throw new NotFoundException('Store not found');
    return s.baseCurrency || 'USD';
  }

  async createPlan(storeId: string, body: any) {
    return this.planModel.create({ storeId, ...this.cleanPlan(body, await this.storeCurrency(storeId)) });
  }

  async updatePlan(storeId: string, planId: string, body: any) {
    const plan = await this.planModel.findOne({ _id: planId, storeId }).catch(() => null);
    if (!plan) throw new NotFoundException('Plan not found');
    const next = this.cleanPlan({ ...plan.toObject(), ...body }, plan.currency);
    // price / type changes never touch existing members: they keep their current period
    Object.assign(plan, next);
    if (body?.status === 'archived' || body?.status === 'active') plan.status = body.status;
    return plan.save();
  }

  listPlans(storeId: string, onlyActive = false) {
    return this.planModel.find({ storeId, ...(onlyActive ? { status: 'active' } : {}) }).sort({ tier: 1, amount: 1 }).lean();
  }

  // ---------------- access check (the gate for plan-locked content) ----------------

  /** Has a live, paid-up (or in-grace) membership whose plan is `requiredPlanId` or a HIGHER tier. */
  async hasPlanAccess(storeId: string, customerId: string, requiredPlanId: string, now = new Date()): Promise<boolean> {
    if (!storeId || !customerId || !requiredPlanId) return false;
    const required = await this.planModel.findOne({ _id: requiredPlanId, storeId }).lean().catch(() => null);
    if (!required) return false;
    const subs = await this.subModel.find({ storeId, customerId, status: { $in: ['trialing', 'active', 'past_due'] } }).lean();
    for (const s of subs) {
      if (s.awaitingFirstPayment) continue;
      if (s.status === 'past_due') {
        const plan = await this.planModel.findOne({ _id: s.planId, storeId }).lean();
        if (!s.dueAt || now > accessUntil(s.dueAt, plan?.graceDays ?? 0)) continue;
      } else if (s.currentPeriodEnd && now > s.currentPeriodEnd) continue;
      if (s.planId === requiredPlanId) return true;
      const own = await this.planModel.findOne({ _id: s.planId, storeId }).lean();
      if (own && own.tier > required.tier) return true;
    }
    return false;
  }

  // ---------------- buyer actions ----------------

  async join(storeId: string, customerId: string, planId: string) {
    const plan = await this.planModel.findOne({ _id: planId, storeId, status: 'active' }).catch(() => null);
    if (!plan) throw new NotFoundException('Plan not found');
    const now = new Date();
    const base: any = { storeId, customerId, planId, provider: 'manual', audit: [audit('joined', customerId)] };
    if (plan.type === 'free') Object.assign(base, { status: 'active', currentPeriodStart: now, currentPeriodEnd: null });
    else if (plan.type === 'recurring' && plan.trialDays > 0)
      Object.assign(base, { status: 'trialing', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + plan.trialDays * DAY) });
    else Object.assign(base, { status: 'past_due', awaitingFirstPayment: true, dueAt: now, currentPeriodStart: null, currentPeriodEnd: null });
    try {
      return await this.subModel.create(base);
    } catch (e: any) {
      if (e?.code === 11000) throw new ConflictException('You already have this membership');
      throw e;
    }
  }

  private async own(storeId: string, customerId: string, id: string) {
    const s = await this.subModel.findOne({ _id: id, storeId, customerId }).catch(() => null);
    if (!s) throw new NotFoundException('Membership not found');
    return s;
  }

  mine(storeId: string, customerId: string) {
    return this.subModel.find({ storeId, customerId }).sort({ createdAt: -1 }).lean();
  }

  async cancel(storeId: string, customerId: string, id: string) {
    const s = await this.own(storeId, customerId, id);
    if (!LIVE.includes(s.status)) throw new BadRequestException('Membership is not active');
    const plan = await this.planModel.findOne({ _id: s.planId, storeId }).lean();
    await SUBSCRIPTION_PROVIDERS[s.provider]?.cancel(s.providerSubscriptionId);
    if (!s.currentPeriodEnd || plan?.type !== 'recurring' || s.awaitingFirstPayment) {
      s.status = 'cancelled';
    } else s.cancelAtPeriodEnd = true; // keeps access until the period ends
    s.audit.push(audit('cancel_requested', customerId));
    await s.save();
    return s;
  }

  async pause(storeId: string, customerId: string, id: string) {
    const s = await this.own(storeId, customerId, id);
    const plan = await this.planModel.findOne({ _id: s.planId, storeId }).lean();
    if (!plan?.pauseAllowed) throw new ForbiddenException('This plan cannot be paused');
    if (s.status !== 'active') throw new BadRequestException('Only an active membership can be paused');
    s.status = 'paused';
    s.pausedAt = new Date();
    s.audit.push(audit('paused', customerId));
    return s.save();
  }

  async resume(storeId: string, customerId: string, id: string) {
    const s = await this.own(storeId, customerId, id);
    if (s.status !== 'paused' || !s.pausedAt) throw new BadRequestException('Membership is not paused');
    const pausedMs = Date.now() - s.pausedAt.getTime();
    if (s.currentPeriodEnd) s.currentPeriodEnd = new Date(s.currentPeriodEnd.getTime() + pausedMs); // the pause does not eat paid time
    s.status = 'active';
    s.pausedAt = null;
    s.audit.push(audit('resumed', customerId));
    return s.save();
  }

  /** Upgrade (higher tier / price) = immediate, prorated; downgrade = switches at the end of the period. */
  async changePlan(storeId: string, customerId: string, id: string, newPlanId: string) {
    const s = await this.own(storeId, customerId, id);
    if (!['active', 'trialing'].includes(s.status)) throw new BadRequestException('Only an active membership can change plan');
    const [cur, next] = await Promise.all([
      this.planModel.findOne({ _id: s.planId, storeId }).lean(),
      this.planModel.findOne({ _id: newPlanId, storeId, status: 'active' }).lean().catch(() => null),
    ]);
    if (!cur || !next) throw new NotFoundException('Plan not found');
    if (cur._id.toString() === next._id.toString()) throw new BadRequestException('Already on this plan');
    if (next.type !== 'recurring' || cur.type !== 'recurring') throw new BadRequestException('Only recurring plans can be switched');

    const isUpgrade = next.tier > cur.tier || (next.tier === cur.tier && next.amount > cur.amount);
    if (!isUpgrade) {
      s.pendingPlanId = String(next._id);
      s.audit.push(audit('downgrade_scheduled', customerId, String(next._id)));
      await s.save();
      return { subscription: s, amountDue: 0, effective: 'period_end' as const };
    }
    const now = new Date();
    const credit = s.currentPeriodStart && s.currentPeriodEnd && s.status === 'active' ? prorationCredit(cur.amount, s.currentPeriodStart, s.currentPeriodEnd, now) : 0;
    const due = upgradeAmountDue(next.amount, credit);
    s.planId = String(next._id);
    s.pendingPlanId = null;
    s.amountDue = due;
    s.audit.push(audit('upgraded', customerId, `due ${due} (credit ${credit})`));
    await s.save();
    return { subscription: s, amountDue: due, credit, effective: 'now' as const };
  }

  // ---------------- seller actions ----------------

  listSubscribers(storeId: string, status?: string, limit = 50) {
    return this.subModel.find({ storeId, ...(status ? { status } : {}) }).sort({ createdAt: -1 }).limit(Math.min(limit, 200)).lean();
  }

  /** Seller confirms the period was paid (manual provider): starts / extends the period. Idempotent per period via the `paidThrough` guard. */
  async markPaid(storeId: string, id: string, by: string) {
    const s = await this.subModel.findOne({ _id: id, storeId }).catch(() => null);
    if (!s) throw new NotFoundException('Subscription not found');
    if (!['trialing', 'active', 'past_due'].includes(s.status)) throw new BadRequestException('Subscription is not payable');
    const plan = await this.planModel.findOne({ _id: s.planId, storeId }).lean();
    if (!plan) throw new NotFoundException('Plan not found');
    const now = new Date();
    if (plan.type === 'one_time') {
      s.status = 'active'; s.currentPeriodEnd = null; s.currentPeriodStart = now;
    } else {
      // renewal extends from the old end when it is still ahead (paid early), else from now
      const from = s.currentPeriodEnd && s.currentPeriodEnd > now && s.status === 'active' ? s.currentPeriodEnd : now;
      s.currentPeriodStart = from;
      s.currentPeriodEnd = addInterval(from, plan.interval as PlanInterval, plan.intervalCount);
      s.status = 'active';
    }
    s.periodsPaid += 1;
    s.awaitingFirstPayment = false;
    s.dueAt = null; s.failedCount = 0; s.amountDue = 0;
    if (s.pendingPlanId && s.status === 'active' && plan.type === 'recurring') { /* downgrade is applied by processRenewals at the boundary */ }
    s.audit.push(audit('paid', by));
    await s.save();
    return s;
  }

  async sellerGrant(storeId: string, customerId: string, planId: string, by: string) {
    const sub = await this.join(storeId, customerId, planId);
    const plan = await this.planModel.findOne({ _id: planId, storeId }).lean();
    if (plan && plan.type !== 'free') return this.markPaid(storeId, String(sub._id), by); // a manual grant is a gift: counts as paid
    return sub;
  }

  async sellerRevoke(storeId: string, id: string, by: string) {
    const s = await this.subModel.findOne({ _id: id, storeId }).catch(() => null);
    if (!s) throw new NotFoundException('Subscription not found');
    s.status = 'cancelled';
    s.audit.push(audit('revoked', by));
    return s.save();
  }

  // ---------------- renewals + dunning (cron; every step is a conditional update => safe to re-run) ----------------

  async processRenewals(now = new Date()): Promise<RenewalEvent[]> {
    const events: RenewalEvent[] = [];
    const ev = (kind: RenewalEvent['kind'], s: any) => events.push({ kind, subscriptionId: String(s._id), storeId: s.storeId, customerId: s.customerId });

    // 1. reminders, 7 days before an active period ends (once per period)
    const soon = await this.subModel.find({
      status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: { $gt: now, $lte: new Date(now.getTime() + REMINDER_DAYS_BEFORE * DAY) },
    }).limit(500);
    for (const s of soon) {
      const claimed = await this.subModel.updateOne(
        { _id: s._id, $or: [{ reminderSentFor: null }, { reminderSentFor: { $ne: s.currentPeriodEnd } }] },
        { $set: { reminderSentFor: s.currentPeriodEnd } },
      );
      if (claimed.modifiedCount) ev('reminder', s);
    }

    // 2. periods that ended
    const ended = await this.subModel.find({ status: { $in: ['trialing', 'active'] }, currentPeriodEnd: { $ne: null, $lte: now } }).limit(500);
    for (const s of ended) {
      const guard = { _id: s._id, status: s.status, currentPeriodEnd: s.currentPeriodEnd };
      const plan = await this.planModel.findOne({ _id: s.planId, storeId: s.storeId }).lean();
      if (s.cancelAtPeriodEnd) {
        if ((await this.subModel.updateOne(guard, { $set: { status: 'cancelled' }, $push: { audit: audit('cancelled', 'system', 'period ended') } })).modifiedCount) ev('cancelled', s);
      } else if (plan?.fixedLength && s.periodsPaid >= plan.fixedLength) {
        if ((await this.subModel.updateOne(guard, { $set: { status: 'expired' }, $push: { audit: audit('expired', 'system', 'fixed length reached') } })).modifiedCount) ev('expired', s);
      } else {
        const set: any = { status: 'past_due', dueAt: s.currentPeriodEnd, failedCount: 0, awaitingFirstPayment: s.status === 'trialing' };
        if (s.pendingPlanId) { set.planId = s.pendingPlanId; set.pendingPlanId = null; }
        if ((await this.subModel.updateOne(guard, { $set: set, $push: { audit: audit('payment_due', 'system') } })).modifiedCount) ev('payment_failed', s);
      }
    }

    // 3. dunning ladder
    const late = await this.subModel.find({ status: 'past_due', dueAt: { $ne: null } }).limit(500);
    for (const s of late) {
      const plan = await this.planModel.findOne({ _id: s.planId, storeId: s.storeId }).lean();
      const d = dunningDecision({ failedCount: s.failedCount, dueAt: s.dueAt as Date, now, graceDays: plan?.graceDays });
      if (d.action === 'retry') {
        const r = await this.subModel.updateOne({ _id: s._id, status: 'past_due', failedCount: s.failedCount }, { $inc: { failedCount: 1 } });
        if (r.modifiedCount) ev(now > accessUntil(s.dueAt as Date, plan?.graceDays ?? 0) ? 'payment_failed' : 'grace', s);
      } else if (d.action === 'revoke') {
        const r = await this.subModel.updateOne({ _id: s._id, status: 'past_due' }, { $set: { status: 'expired' }, $push: { audit: audit('expired', 'system', 'dunning exhausted') } });
        if (r.modifiedCount) ev('expired', s);
      }
    }
    return events;
  }
}
