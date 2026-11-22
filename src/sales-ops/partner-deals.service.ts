/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { EmailService } from '../otp/services/email.service';
import { SalesCaptureService } from './sales-capture.service';
import { PartnerOnboardingService } from './partner-onboarding.service';
import { SalesPartner, SalesPartnerDocument } from './schemas/sales-partner.schema';
import { SalesPartnerReferral, SalesPartnerReferralDocument } from './schemas/sales-partner-referral.schema';
import { PartnerDeal, PartnerDealDocument } from './schemas/partner-deal.schema';
import { DEAL_PROGRESS, type DealStatus, addWorkingDays, conflictsFor, extendProtection, keysOf, protectedUntilAfter } from './partner-deals.util';
import type { SalesActor } from './sales-ops.util';

const isId = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s);
const clean = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) || null : null);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** A partner can register prospects once the agreement is signed (or if they predate the programme). */
const CAN_REGISTER = new Set(['onboarding', 'live', null, undefined]);

export interface DealInput {
  businessName?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  city?: string;
  link?: string;
  notes?: string;
  consent?: boolean;
  consentNote?: string;
}

/** Channel Partner Programme B7: deal registration, decisions, protection and attribution. */
@Injectable()
export class PartnerDealsService {
  private readonly logger = new Logger(PartnerDealsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly email: EmailService,
    private readonly capture: SalesCaptureService,
    private readonly onboarding: PartnerOnboardingService,
    @InjectModel(SalesPartner.name) private readonly partners: Model<SalesPartnerDocument>,
    @InjectModel(SalesPartnerReferral.name) private readonly referrals: Model<SalesPartnerReferralDocument>,
    @InjectModel(PartnerDeal.name) private readonly deals: Model<PartnerDealDocument>,
  ) {}

  // ── The partner ──────────────────────────────────────────────────────────

  async register(actor: SalesActor, input: DealInput) {
    const p = await this.myPartner(actor);
    if (!CAN_REGISTER.has(p.stage) || p.status !== 'active') throw new ForbiddenException('You can register prospects once your partner agreement is signed.');
    const businessName = clean(input.businessName, 160);
    if (!businessName) throw new BadRequestException('Enter the business name.');
    const phone = clean(input.phone, 40);
    const email = clean(input.email, 160)?.toLowerCase() ?? null;
    if (!phone && !email) throw new BadRequestException('Add the seller’s phone or email, so we can match them when they sign up.');
    if (input.consent !== true) throw new BadRequestException('Only register a seller who agreed to it (B7.1).');
    const keys = keysOf({ phone, email, businessName });
    if (!keys.phoneKey && !keys.emailKey) throw new BadRequestException('Check the phone number or email.');

    const now = new Date();
    const s = await this.onboarding.settings();
    const mineAlready: any = await this.deals.findOne({
      partnerId: String(p._id), status: { $in: ['pending', 'accepted'] },
      $or: [...(keys.phoneKey ? [{ phoneKey: keys.phoneKey }] : []), ...(keys.emailKey ? [{ emailKey: keys.emailKey }] : [])],
    }).select('_id').lean();
    if (mineAlready) throw new BadRequestException('You have already registered this seller.');

    const { conflicts, autoReject } = await this.checkConflicts(String(p._id), keys, p.houseAccounts ?? [], now);
    const doc: any = await this.deals.create({
      partnerId: String(p._id), businessName, contactName: clean(input.contactName, 120), phone, email, city: clean(input.city, 80),
      link: clean(input.link, 300), notes: clean(input.notes, 1000), consentAt: now, consentNote: clean(input.consentNote, 300),
      ...keys, status: autoReject ? 'rejected' : 'pending', submittedAt: now, decisionDueAt: addWorkingDays(now, s.dealResponseWorkingDays),
      ...(autoReject ? { decidedAt: now, decidedHow: 'auto', rejectReason: autoReject } : {}), conflicts,
    });
    if (!autoReject) void this.capture.notifyManagers('Partner deal registration', `${p.name} registered ${businessName}. Decide within ${s.dealResponseWorkingDays} working days.`, null);
    await this.onboarding.refreshStage(String(p._id)).catch(() => undefined);
    return {
      success: true,
      message: autoReject ? `Not accepted: ${autoReject}` : `Registered. Solvexo will accept or reject it within ${s.dealResponseWorkingDays} working days.`,
      data: this.view(doc.toObject(), false),
    };
  }

  async mine(actor: SalesActor) {
    const p = await this.myPartner(actor);
    const rows: any[] = await this.deals.find({ partnerId: String(p._id) }).sort({ submittedAt: -1 }).limit(500).lean();
    const s = await this.onboarding.settings();
    return { success: true, data: { canRegister: CAN_REGISTER.has(p.stage) && p.status === 'active', protectionDays: s.dealProtectionDays, responseDays: s.dealResponseWorkingDays, deals: rows.map((d) => this.view(d, false)) } };
  }

  /** B7.3: the partner shows progress (demo held, trial started) and asks for more protection time. */
  async requestExtension(actor: SalesActor, id: string, input: { progress?: string; note?: string }) {
    const p = await this.myPartner(actor);
    const d = await this.find(id);
    if (d.partnerId !== String(p._id)) throw new ForbiddenException();
    if (d.status !== 'accepted') throw new BadRequestException('Only an accepted registration can be extended.');
    if (!(DEAL_PROGRESS as readonly string[]).includes(input.progress ?? '')) throw new BadRequestException('Say what progress you made.');
    await this.deals.updateOne({ _id: d._id }, { $set: { extensionRequest: { at: new Date(), progress: input.progress, note: clean(input.note, 500) } } });
    void this.capture.notifyManagers('Partner asks to extend a registration', `${p.name}: ${d.businessName} (${input.progress?.replace('_', ' ')}).`, null);
    return { success: true, message: 'Extension requested.' };
  }

  // ── Managers ─────────────────────────────────────────────────────────────

  async list(q: { status?: string; partnerId?: string }) {
    const filter: Record<string, unknown> = {};
    if (q.status === 'overdue') { filter.status = 'pending'; filter.decisionDueAt = { $lt: new Date() }; }
    else if (q.status === 'extension') filter.extensionRequest = { $ne: null };
    else if (q.status) filter.status = q.status;
    if (q.partnerId && isId(q.partnerId)) filter.partnerId = q.partnerId;
    const rows: any[] = await this.deals.find(filter).sort({ submittedAt: -1 }).limit(500).lean();
    const names = new Map(((await this.partners.find({ _id: { $in: [...new Set(rows.map((r) => r.partnerId))] } }).select('name').lean()) as any[]).map((p) => [String(p._id), p.name]));
    const counts: any[] = await this.deals.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
    const overdue = await this.deals.countDocuments({ status: 'pending', decisionDueAt: { $lt: new Date() } });
    const extension = await this.deals.countDocuments({ extensionRequest: { $ne: null } });
    return {
      success: true,
      data: {
        counts: { ...Object.fromEntries(counts.map((c) => [c._id, c.n])), overdue, extension },
        deals: rows.map((d) => ({ ...this.view(d, true), partnerName: names.get(d.partnerId) ?? 'Partner' })),
      },
    };
  }

  async decide(actor: SalesActor, id: string, input: { decision?: 'accept' | 'reject'; reason?: string }) {
    const d = await this.find(id);
    if (d.status !== 'pending') throw new BadRequestException('This registration has already been decided.');
    const s = await this.onboarding.settings();
    const now = new Date();
    if (input.decision === 'accept') {
      // Re-check: a competing registration may have been accepted since this one came in.
      const p: any = await this.partners.findById(d.partnerId).select('houseAccounts').lean();
      const { autoReject } = await this.checkConflicts(d.partnerId, { phoneKey: d.phoneKey, emailKey: d.emailKey, nameKey: d.nameKey }, p?.houseAccounts ?? [], now, String(d._id));
      if (autoReject) throw new BadRequestException(`Cannot accept: ${autoReject} Reject it with that reason.`);
      await this.deals.updateOne({ _id: d._id }, { $set: { status: 'accepted', decidedAt: now, decidedBy: actor.adminId, decidedHow: 'manager', protectedUntil: protectedUntilAfter(now, s.dealProtectionDays) } });
    } else if (input.decision === 'reject') {
      const reason = clean(input.reason, 500);
      if (!reason) throw new BadRequestException('Give the reason (B7.2): the partner sees it.');
      await this.deals.updateOne({ _id: d._id }, { $set: { status: 'rejected', decidedAt: now, decidedBy: actor.adminId, decidedHow: 'manager', rejectReason: reason } });
    } else throw new BadRequestException('Accept or reject.');
    void this.tellPartner(d.partnerId, input.decision === 'accept'
      ? `Your registration of <strong>${esc(d.businessName)}</strong> is accepted and protected for ${s.dealProtectionDays} days.`
      : `Your registration of <strong>${esc(d.businessName)}</strong> was not accepted. Reason: ${esc(clean(input.reason, 500)!)}`);
    return { success: true, message: input.decision === 'accept' ? 'Accepted' : 'Rejected' };
  }

  async extend(actor: SalesActor, id: string, input: { days?: number; progress?: string; note?: string }) {
    const d = await this.find(id);
    if (d.status !== 'accepted' && d.status !== 'expired') throw new BadRequestException('Only an accepted (or just expired) registration can be extended.');
    const s = await this.onboarding.settings();
    const days = Math.max(1, Math.min(365, Math.round(Number(input.days ?? s.dealProtectionDays)) || s.dealProtectionDays));
    const progress = (DEAL_PROGRESS as readonly string[]).includes(input.progress ?? '') ? input.progress! : (d.extensionRequest?.progress ?? 'other');
    const now = new Date();
    const until = extendProtection(d.protectedUntil ? new Date(d.protectedUntil) : null, now, days);
    await this.deals.updateOne({ _id: d._id }, {
      $set: { status: 'accepted', protectedUntil: until, extensionRequest: null },
      $push: { extensions: { at: now, by: actor.adminId, progress, note: clean(input.note, 500) ?? d.extensionRequest?.note ?? null, until } },
    });
    void this.tellPartner(d.partnerId, `Protection for <strong>${esc(d.businessName)}</strong> is extended to ${until.toISOString().slice(0, 10)}.`);
    return { success: true, message: `Protected until ${until.toISOString().slice(0, 10)}` };
  }

  async close(id: string, outcome: 'lost') {
    const d = await this.find(id);
    if (!['pending', 'accepted', 'expired'].includes(d.status)) throw new BadRequestException('This registration is already closed.');
    await this.deals.updateOne({ _id: d._id }, { $set: { status: outcome, extensionRequest: null } });
    return { success: true, message: 'Marked as lost' };
  }

  // ── Daily: overdue decisions, expiry, and crediting sellers who signed up ──

  @Cron('15 5 * * *') // before the commission run (05:30), so a matched seller is credited the same morning
  async dailyJob() {
    await this.redis.withLock('partner-deals-daily', 600_000, async () => { await this.run(); });
  }

  async run() {
    const now = new Date();
    const won = await this.matchSignups(now);
    const expired = await this.deals.updateMany({ status: 'accepted', protectedUntil: { $lt: now } }, { $set: { status: 'expired' } });
    const overdue: any[] = await this.deals.find({ status: 'pending', decisionDueAt: { $lt: now }, overdueNotifiedAt: null }).select('_id').lean();
    if (overdue.length) {
      void this.capture.notifyManagers('Partner registrations waiting too long', `${overdue.length} deal registration${overdue.length === 1 ? ' is' : 's are'} past the reply deadline (B7.2).`, null);
      await this.deals.updateMany({ _id: { $in: overdue.map((o) => o._id) } }, { $set: { overdueNotifiedAt: now } });
    }
    return { won, expired: expired.modifiedCount, overdue: overdue.length };
  }

  /**
   * A seller who signs up matching an accepted, protected registration is credited to that partner (B7.4), unless they
   * are already credited, or signed up earlier than the registration through another partner's link.
   */
  async matchSignups(now = new Date()): Promise<number> {
    const live: any[] = await this.deals.find({ status: 'accepted', protectedUntil: { $gte: now } }).lean();
    if (!live.length) return 0;
    const since = new Date(Math.min(...live.map((d) => new Date(d.submittedAt).getTime())));
    const sellers: any[] = await this.db.repositories.sellerModel
      .find({ isDelete: { $ne: true }, createdAt: { $gte: since } }).select('email phone createdAt acquisitionPartnerCode').lean();
    if (!sellers.length) return 0;
    const credited = new Set(((await this.referrals.find({ sellerId: { $in: sellers.map((s) => String(s._id)) } }).select('sellerId').lean()) as any[]).map((r) => r.sellerId));
    const codes = new Map(((await this.partners.find({}).select('code').lean()) as any[]).map((p) => [p.code, String(p._id)]));
    let n = 0;
    for (const d of live.sort((a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime())) {
      const match = sellers.find((s) => {
        const k = keysOf({ phone: s.phone, email: s.email });
        return (d.phoneKey && k.phoneKey === d.phoneKey) || (d.emailKey && k.emailKey === d.emailKey);
      });
      if (!match) continue;
      const sellerId = String(match._id);
      const viaCode = match.acquisitionPartnerCode ? codes.get(match.acquisitionPartnerCode) : undefined;
      const codeEarlier = viaCode && viaCode !== d.partnerId && new Date(match.createdAt).getTime() < new Date(d.submittedAt).getTime();
      if (!credited.has(sellerId) && !codeEarlier) {
        try {
          await this.referrals.create({ sellerId, partnerId: d.partnerId, source: 'registration', effectiveFrom: new Date(match.createdAt) });
          credited.add(sellerId);
        } catch { /* credited meanwhile */ }
      }
      const mine = (await this.referrals.findOne({ sellerId }).select('partnerId').lean()) as any;
      await this.deals.updateOne({ _id: d._id }, { $set: mine?.partnerId === d.partnerId
        ? { status: 'won', sellerId, wonAt: now }
        : { status: 'lost', sellerId, rejectReason: 'The seller signed up through another partner first.' } });
      if (mine?.partnerId === d.partnerId) n++;
    }
    return n;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async checkConflicts(partnerId: string, keys: ReturnType<typeof keysOf>, houseAccounts: string[], now: Date, excludeId?: string) {
    const or = [
      ...(keys.phoneKey ? [{ phoneKey: keys.phoneKey }] : []), ...(keys.emailKey ? [{ emailKey: keys.emailKey }] : []), ...(keys.nameKey ? [{ nameKey: keys.nameKey }] : []),
    ];
    const others: any[] = or.length ? await this.deals.find({ $or: or, status: { $in: ['pending', 'accepted'] }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).lean() : [];
    const pnames = new Map(((await this.partners.find({ _id: { $in: [...new Set(others.map((o) => o.partnerId))] } }).select('name').lean()) as any[]).map((p) => [String(p._id), p.name]));
    // Existing customers: sellers with this email, or this phone (phones are stored as typed, so match on the last digits).
    const r = this.db.repositories;
    const sellerOr: any[] = [];
    if (keys.emailKey) sellerOr.push({ email: keys.emailKey });
    if (keys.phoneKey) sellerOr.push({ phone: { $regex: `${keys.phoneKey.split('').join('\\D*')}$` } });
    const sellers: any[] = sellerOr.length ? await r.sellerModel.find({ isDelete: { $ne: true }, $or: sellerOr }).select('name email phone').limit(20).lean() : [];
    const nameMatches: any[] = keys.nameKey ? await r.storeModel.find({ isDelete: { $ne: true }, name: { $regex: `^${escapeRx(keys.nameKey).split('').join('[^a-z0-9]*')}`, $options: 'i' } }).select('sellerId name').limit(5).lean() : [];
    const customers = [
      ...sellers.map((s) => ({ sellerId: String(s._id), name: s.name ?? 'seller', keys: keysOf({ phone: s.phone, email: s.email }) })),
      ...nameMatches.map((s) => ({ sellerId: String(s.sellerId), name: s.name, keys: { phoneKey: null, emailKey: null, nameKey: keysOf({ businessName: s.name }).nameKey } })),
    ];
    return conflictsFor({
      keys, partnerId, houseAccounts, now, customers,
      others: others.map((o) => ({
        id: String(o._id), partnerId: o.partnerId, partnerName: pnames.get(o.partnerId) ?? 'another partner', status: o.status as DealStatus,
        submittedAt: new Date(o.submittedAt), protectedUntil: o.protectedUntil ? new Date(o.protectedUntil) : null,
        keys: { phoneKey: o.phoneKey, emailKey: o.emailKey, nameKey: o.nameKey },
      })),
    });
  }

  private view(d: any, forManager: boolean) {
    const now = Date.now();
    return {
      _id: String(d._id), partnerId: d.partnerId, businessName: d.businessName, contactName: d.contactName ?? null, phone: d.phone ?? null,
      email: d.email ?? null, city: d.city ?? null, link: d.link ?? null, notes: d.notes ?? null, status: d.status as DealStatus,
      submittedAt: d.submittedAt, decisionDueAt: d.decisionDueAt, overdue: d.status === 'pending' && new Date(d.decisionDueAt).getTime() < now,
      decidedAt: d.decidedAt ?? null, decidedHow: d.decidedHow ?? null, rejectReason: d.rejectReason ?? null,
      protectedUntil: d.protectedUntil ?? null, extensions: (d.extensions ?? []).map((e: any) => ({ at: e.at, progress: e.progress, until: e.until })),
      extensionRequest: d.extensionRequest ?? null, wonAt: d.wonAt ?? null,
      conflicts: forManager ? (d.conflicts ?? []) : undefined, consentNote: forManager ? (d.consentNote ?? null) : undefined,
    };
  }

  private async tellPartner(partnerId: string, html: string) {
    const p: any = await this.partners.findById(partnerId).select('email name').lean();
    if (!p?.email) return;
    await this.email.sendMail(p.email, 'Your Solvexo deal registration', `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1c1d1b"><p>Hi ${esc(p.name)},</p><p>${html}</p><p style="color:#888;font-size:12px">Solvexo Channel Partner Programme</p></div>`).catch(() => false);
  }

  private async myPartner(actor: SalesActor): Promise<any> {
    const p: any = await this.partners.findOne({ adminId: actor.adminId }).lean();
    if (!p) throw new ForbiddenException('You are not set up as a partner.');
    return p;
  }

  private async find(id: string): Promise<any> {
    if (!isId(id)) throw new NotFoundException('Registration not found.');
    const d = await this.deals.findById(id).lean();
    if (!d) throw new NotFoundException('Registration not found.');
    return d;
  }
}

function escapeRx(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
