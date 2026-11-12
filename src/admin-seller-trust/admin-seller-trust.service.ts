/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { AdminConfigService } from '../admin-config/admin-config.service';
import { StoreService } from '../store/store.service';
import { AdminMarketplaceService } from '../admin-marketplace/admin-marketplace.service';
import { VERIFICATION_STATUSES, type NtnCheckResult } from '../store/schemas/store.schema';
import { SellerTrustService, HAS_NTN_FILTER, storeTrustSnapshot } from '../seller-trust/seller-trust.service';
import { deadlineInfo } from '../seller-trust/seller-trust-deadline.util';
import { SellerTrustQueryDto } from './dto/seller-trust-query.dto';

export interface AuditMeta { adminId: string; ip?: string; userAgent?: string }

const DAY_MS = 24 * 60 * 60 * 1000;
export const REMINDER_INTERVAL_MS = DAY_MS;
const EXPORT_MAX_ROWS = 20_000;

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const csvEsc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/** Fields the list/export read (aggregate — so `select: false` paths are fine to project). */
const LIST_PROJECTION = {
  name: 1, slug: 1, status: 1, sellerId: 1, country: 1, businessType: 1, taxId: 1, categoryId: 1, createdAt: 1,
  verificationStatus: 1, verificationSubmittedAt: 1, verificationDueAt: 1, riskLevel: 1, riskReasons: 1, payoutHold: 1,
  'verification.taxId': 1, 'verification.cnicNumber': 1, 'verification.strn': 1, 'verification.businessProfile': 1,
  'verification.history.action': 1, 'verification.history.at': 1,
};

/**
 * Admin "Seller trust" workspace: KYC review queue across every store, the
 * enforcement switch, reminders, NTN checks and payout holds. The review
 * actions themselves (under review / approve / reject / ask for info) live in
 * AdminMarketplaceService and are delegated to, so the old Leads endpoints and
 * this module share one implementation.
 */
@Injectable()
export class AdminSellerTrustService {
  private readonly logger = new Logger(AdminSellerTrustService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly notificationsService: NotificationsService,
    private readonly adminConfig: AdminConfigService,
    private readonly storeService: StoreService,
    private readonly adminMarketplace: AdminMarketplaceService,
    private readonly sellerTrust: SellerTrustService,
  ) {}

  private get r() { return this.db.repositories; }

  private log(action: string, description: string, meta: AuditMeta, targetId?: string, metadata?: Record<string, unknown>) {
    this.activityLogService.log({
      storeId: 'platform', category: 'moderation', action, description,
      actorId: meta.adminId, actorRole: 'admin', targetId, targetType: targetId ? 'store' : undefined,
      ip: meta.ip, userAgent: meta.userAgent, ...(metadata ? { metadata } : {}),
    });
  }

  private assertStoreId(storeId: string) {
    if (!storeId || !isValidObjectId(storeId)) throw new BadRequestException('A valid storeId is required');
  }

  // ── Settings ──

  private shapeSettings(s: { enforcementStartedAt: Date | null; graceDays: number }) {
    return {
      enforcementStartedAt: s.enforcementStartedAt,
      graceDays: s.graceDays,
      firstDueAt: s.enforcementStartedAt ? new Date(new Date(s.enforcementStartedAt).getTime() + s.graceDays * DAY_MS) : null,
    };
  }

  async getSettings() {
    return { success: true, data: this.shapeSettings(await this.sellerTrust.getSettings()) };
  }

  /** `enforcementStartedAt: 'now'` starts enforcement (kept as-is if it already started, so a second click can't
   *  push everyone's deadline out); `null` stops it. Deadlines + marketplace visibility are re-synced right away. */
  async updateSettings(dto: { enforcementStartedAt?: 'now' | null; graceDays?: number }, meta: AuditMeta) {
    const current = await this.sellerTrust.getSettings();
    const patch: { enforcementStartedAt?: Date | null; graceDays?: number } = {};
    if (dto.enforcementStartedAt === null) patch.enforcementStartedAt = null;
    else if (dto.enforcementStartedAt === 'now' && !current.enforcementStartedAt) patch.enforcementStartedAt = new Date();
    if (dto.graceDays !== undefined) patch.graceDays = dto.graceDays;

    const next = await this.adminConfig.updateSellerTrustSettings(patch, meta);
    if (Object.keys(patch).length) {
      await this.sellerTrust.syncDeadlines();
      // Risk levels depend on "deadline passed" — refresh them in the background (also done by the daily cron).
      this.sellerTrust.recomputeAll().catch((err) => this.logger.warn(`recomputeAll after settings change failed: ${err?.message}`));
      const what = patch.enforcementStartedAt === null ? 'stopped' : patch.enforcementStartedAt ? 'started' : 'updated';
      this.log('seller_trust_enforcement_' + what, `Seller verification enforcement ${what} (grace ${next.graceDays} days)`, meta, undefined, { ...patch });
    }
    return { success: true, message: 'Seller trust settings saved', data: this.shapeSettings(next) };
  }

  // ── Summary ──

  async getSummary(now = new Date()) {
    const [settings, facets] = await Promise.all([
      this.sellerTrust.getSettings(),
      this.r.storeModel.aggregate([
        { $match: { isDelete: false } },
        {
          $facet: {
            total: [{ $count: 'n' }],
            withNtn: [{ $match: HAS_NTN_FILTER }, { $count: 'n' }],
            byStatus: [{ $group: { _id: '$verificationStatus', n: { $sum: 1 } } }],
            byRisk: [{ $group: { _id: '$riskLevel', n: { $sum: 1 } } }],
            deadlinePassed: [{ $match: { verificationStatus: { $ne: 'verified' }, verificationDueAt: { $ne: null, $lte: now } } }, { $count: 'n' }],
          },
        },
      ]),
    ]);
    return { success: true, data: this.shapeSummary(facets?.[0] ?? {}, settings) };
  }

  /** Pure mapping of the summary facet result (exported for tests). */
  shapeSummary(f: any, settings: { enforcementStartedAt: Date | null; graceDays: number }) {
    const n = (arr: any[] | undefined) => arr?.[0]?.n ?? 0;
    const totalStores = n(f.total);
    const withNtn = n(f.withNtn);
    const byStatus = Object.fromEntries(VERIFICATION_STATUSES.map((st) => [st, 0])) as Record<(typeof VERIFICATION_STATUSES)[number], number>;
    for (const row of f.byStatus ?? []) {
      const key = (row._id ?? 'not_started') as keyof typeof byStatus;
      if (key in byStatus) byStatus[key] += row.n;
    }
    const risk = { low: 0, medium: 0, high: 0 } as Record<string, number>;
    for (const row of f.byRisk ?? []) risk[row._id ?? 'low'] = (risk[row._id ?? 'low'] ?? 0) + row.n;
    const shaped = this.shapeSettings(settings);
    return {
      totalStores,
      withNtn,
      withoutNtn: totalStores - withNtn,
      byStatus,
      highRisk: risk.high,
      mediumRisk: risk.medium,
      waitingReview: byStatus.pending + byStatus.under_review,
      deadlinePassed: n(f.deadlinePassed),
      enforcement: { startedAt: shaped.enforcementStartedAt, graceDays: shaped.graceDays, firstDueAt: shaped.firstDueAt },
    };
  }

  // ── List / export ──

  /** Mongo $match for the list filters (shared by list, export and bulk reminders). */
  async buildMatch(q: Partial<SellerTrustQueryDto>, now = new Date()): Promise<Record<string, any>> {
    const and: Record<string, any>[] = [{ isDelete: false }];
    if (q.country) {
      const c = q.country.trim().toUpperCase();
      and.push(c === 'PK' ? { country: { $in: ['PK', null] } } : { country: c });
    }
    if (q.ntn === 'yes') and.push(HAS_NTN_FILTER);
    if (q.ntn === 'no') and.push({ $nor: HAS_NTN_FILTER.$or });
    if (q.status) and.push(q.status === 'not_started' ? { verificationStatus: { $in: ['not_started', null] } } : { verificationStatus: q.status });
    if (q.risk) and.push(q.risk === 'low' ? { riskLevel: { $in: ['low', null] } } : { riskLevel: q.risk });
    if (q.limited === 'yes') and.push({ verificationStatus: { $ne: 'verified' }, verificationDueAt: { $ne: null, $lte: now } });
    if (q.limited === 'no') and.push({ $or: [{ verificationStatus: 'verified' }, { verificationDueAt: null }, { verificationDueAt: { $gt: now } }] });
    const term = (q.search ?? '').trim();
    if (term) {
      const rx = new RegExp(escapeRx(term), 'i');
      const sellers: any[] = await this.r.sellerModel.find({ $or: [{ name: rx }, { email: rx }, { phone: rx }] }, { _id: 1 }).limit(1000).lean();
      and.push({
        $or: [
          { name: rx }, { slug: rx }, { taxId: rx }, { 'verification.taxId': rx }, { 'verification.cnicNumber': rx },
          ...(sellers.length ? [{ sellerId: { $in: sellers.map((s) => String(s._id)) } }] : []),
        ],
      });
    }
    return and.length === 1 ? and[0] : { $and: and };
  }

  private sortStage(sort: string | undefined) {
    if (sort === 'created') return { createdAt: -1, _id: -1 };
    if (sort === 'risk') return { riskRank: -1, verificationSubmittedAt: -1, createdAt: -1, _id: -1 };
    // Oldest submission first (longest waiting); never-submitted stores last.
    return { submittedSortKey: 1, createdAt: 1, _id: 1 };
  }

  private basePipeline(match: Record<string, any>, sort: string | undefined) {
    return [
      { $match: match },
      { $addFields: { submittedSortKey: { $ifNull: ['$verificationSubmittedAt', new Date('9999-12-31T00:00:00Z')] }, riskRank: { $switch: { branches: [{ case: { $eq: ['$riskLevel', 'high'] }, then: 2 }, { case: { $eq: ['$riskLevel', 'medium'] }, then: 1 }], default: 0 } } } },
      { $sort: this.sortStage(sort) },
    ];
  }

  /** Attaches seller contact + category names, and shapes each store into a list row. */
  private async shapeRows(stores: any[], now = new Date()) {
    const sellerIds = [...new Set(stores.map((s) => String(s.sellerId)))];
    const categoryIds = [...new Set(stores.map((s) => s.categoryId).filter(Boolean))];
    const [sellers, categories]: any[][] = await Promise.all([
      sellerIds.length ? this.r.sellerModel.find({ _id: { $in: sellerIds } }, { name: 1, email: 1, phone: 1 }).lean() : [],
      categoryIds.length ? this.r.categoryModel.find({ _id: { $in: categoryIds } }, { name: 1 }).lean() : [],
    ]);
    const sellerById = new Map(sellers.map((x) => [String(x._id), x]));
    const categoryById = new Map(categories.map((c) => [String(c._id), c.name]));
    return stores.map((s) => {
      const seller = sellerById.get(String(s.sellerId));
      const trust = storeTrustSnapshot(s, now);
      const v = s.verification ?? {};
      const lastSubmit = [...(v.history ?? [])].reverse().find((h: any) => h.action === 'submitted' || h.action === 'resubmitted');
      return {
        storeId: String(s._id),
        storeName: s.name,
        slug: s.slug,
        status: s.status,
        sellerId: s.sellerId,
        sellerName: seller?.name ?? null,
        sellerEmail: seller?.email ?? null,
        sellerPhone: seller?.phone ?? null,
        country: s.country ?? 'PK',
        businessType: s.businessType ?? null,
        hasNtn: trust.hasNtn,
        ntn: trust.ntn,
        cnicNumber: v.cnicNumber ?? null,
        strn: v.strn ?? null,
        verificationStatus: trust.verificationStatus,
        submittedAt: s.verificationSubmittedAt ?? lastSubmit?.at ?? null,
        riskLevel: trust.riskLevel,
        riskReasons: trust.riskReasons,
        dueAt: trust.dueAt,
        limited: trust.limited,
        payoutHold: trust.payoutHold,
        categories: v.businessProfile?.regulatedCategories ?? [],
        sourcing: v.businessProfile?.sourcing ?? null,
        categoryName: s.categoryId ? categoryById.get(String(s.categoryId)) ?? null : null,
        createdAt: s.createdAt,
      };
    });
  }

  async listStores(q: SellerTrustQueryDto, now = new Date()) {
    const page = q.page ?? 1;
    const limit = Math.min(q.limit ?? 20, 100);
    const match = await this.buildMatch(q, now);
    const [res] = await this.r.storeModel.aggregate([
      ...this.basePipeline(match, q.sort) as any[],
      { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }, { $project: LIST_PROJECTION }], total: [{ $count: 'n' }] } },
    ]);
    const items = await this.shapeRows(res?.items ?? [], now);
    return { success: true, data: { items, total: res?.total?.[0]?.n ?? 0, page, limit } };
  }

  async exportStoresCsv(q: SellerTrustQueryDto, now = new Date()): Promise<string> {
    const match = await this.buildMatch(q, now);
    const stores = await this.r.storeModel.aggregate([
      ...this.basePipeline(match, q.sort) as any[],
      { $limit: EXPORT_MAX_ROWS },
      { $project: LIST_PROJECTION },
    ]);
    const rows = await this.shapeRows(stores, now);
    const head = ['store', 'slug', 'store_status', 'seller', 'email', 'phone', 'country', 'business_type', 'ntn', 'cnic', 'strn',
      'verification_status', 'submitted_at', 'risk', 'risk_reasons', 'due_date', 'limited', 'payout_hold', 'category', 'sells', 'sourcing', 'created_at'];
    const lines = rows.map((x) => [
      x.storeName, x.slug, x.status, x.sellerName, x.sellerEmail, x.sellerPhone, x.country, x.businessType, x.ntn, x.cnicNumber, x.strn,
      x.verificationStatus, day(x.submittedAt), x.riskLevel, x.riskReasons.map((r) => r.label).join('; '), day(x.dueAt),
      x.limited ? 'yes' : 'no', x.payoutHold ? `yes${x.payoutHold.reason ? `: ${x.payoutHold.reason}` : ''}` : 'no',
      x.categoryName, x.categories.join('; '), x.sourcing, day(x.createdAt),
    ].map(csvEsc).join(','));
    return [head.join(','), ...lines].join('\n');
  }

  // ── Detail ──

  async getStoreDetail(storeId: string, now = new Date()) {
    this.assertStoreId(storeId);
    const store: any = await this.r.storeModel.findOne({ _id: storeId, isDelete: false })
      .select('+verification +riskLevel +riskReasons +riskUpdatedAt').lean();
    if (!store) throw new NotFoundException('Store not found');
    const [seller, category, evaluation, settings]: any[] = await Promise.all([
      this.r.sellerModel.findById(store.sellerId, { name: 1, email: 1, phone: 1, address: 1, isVerified: 1 }).lean(),
      store.categoryId ? this.r.categoryModel.findById(store.categoryId, { name: 1 }).lean() : null,
      this.storeService.getVerificationEvaluationForAdmin(storeId),
      this.sellerTrust.getSettings(),
    ]);
    const v = store.verification ?? {};
    const lastSubmit = [...(v.history ?? [])].reverse().find((h: any) => h.action === 'submitted' || h.action === 'resubmitted');
    let ntnCheck = v.ntnCheck?.result ? { ...v.ntnCheck, checkedByName: null as string | null } : null;
    if (ntnCheck?.checkedBy && isValidObjectId(ntnCheck.checkedBy)) {
      const admin: any = await this.r.adminModel.findById(ntnCheck.checkedBy, { name: 1, email: 1 }).lean().catch(() => null);
      ntnCheck.checkedByName = admin?.name ?? admin?.email ?? null;
    }
    return {
      success: true,
      data: {
        storeId: String(store._id),
        storeName: store.name,
        slug: store.slug,
        logo: store.logo ?? null,
        status: store.status,
        country: store.country ?? 'PK',
        businessType: store.businessType ?? null,
        categoryName: category?.name ?? null,
        verificationLevel: evaluation.requirements.verificationLevel,
        verificationStatus: store.verificationStatus ?? 'not_started',
        submittedAt: store.verificationSubmittedAt ?? lastSubmit?.at ?? null,
        reviewedAt: store.reviewedAt ?? null,
        rejectionReason: store.rejectionReason ?? null,
        infoRequestMessage: store.infoRequestMessage ?? null,
        badges: store.badges ?? [],
        verification: {
          legalBusinessName: v.legalBusinessName ?? null,
          registrationNumber: v.registrationNumber ?? null,
          taxId: v.taxId ?? null,
          cnicNumber: v.cnicNumber ?? null,
          strn: v.strn ?? null,
          businessAddress: v.businessAddress ?? null,
          idDocumentType: v.idDocumentType ?? null,
          authorizedContact: v.authorizedContact ?? null,
          businessProfile: this.storeService.shapeBusinessProfile(v.businessProfile),
          ntnCheck,
          history: v.history ?? [],
        },
        invoiceTaxId: store.taxId ?? null,
        taxRegistered: store.taxRegistered ?? null,
        hasNtn: storeTrustSnapshot(store, now).hasNtn,
        documents: evaluation.documents,
        requirements: evaluation.requirements,
        missingFields: evaluation.missingFields,
        missingDocuments: evaluation.missingDocuments,
        canApprove: evaluation.canSubmit,
        risk: { level: store.riskLevel ?? 'low', reasons: store.riskReasons ?? [], updatedAt: store.riskUpdatedAt ?? null },
        riskLevel: store.riskLevel ?? 'low',
        riskReasons: store.riskReasons ?? [],
        deadline: deadlineInfo(store, settings, now),
        payoutHold: store.payoutHold?.active ? store.payoutHold : null,
        // Card money of a Stripe Connect store goes straight to its own Stripe account — a hold here only
        // covers balances Solvexo holds (no Stripe API is called).
        stripeConnect: !!store.stripeConnectChargesEnabled || store.stripeConnectStatus === 'active',
        lastTrustReminderAt: store.lastTrustReminderAt ?? null,
        contactEmail: store.contactEmail ?? null,
        contactPhone: store.contactPhone ?? null,
        seller: {
          id: store.sellerId,
          name: seller?.name ?? null,
          email: seller?.email ?? null,
          emailVerified: !!seller?.isVerified,
          phone: seller?.phone ?? null,
          address: seller?.address ?? null,
        },
        createdAt: store.createdAt,
      },
    };
  }

  // ── Review actions (one implementation, shared with the old Leads endpoints) ──

  markUnderReview(storeId: string, meta: AuditMeta) { this.assertStoreId(storeId); return this.adminMarketplace.markUnderReview(storeId, meta); }
  approve(storeId: string, meta: AuditMeta) { this.assertStoreId(storeId); return this.adminMarketplace.approveLead(storeId, meta); }
  reject(storeId: string, reason: string, meta: AuditMeta) { this.assertStoreId(storeId); return this.adminMarketplace.rejectLead(storeId, reason, meta); }
  requestInfo(storeId: string, message: string, meta: AuditMeta) { this.assertStoreId(storeId); return this.adminMarketplace.requestInfo(storeId, message, meta); }

  async recordNtnCheck(storeId: string, result: NtnCheckResult, meta: AuditMeta) {
    this.assertStoreId(storeId);
    const store: any = await this.r.storeModel.findOne({ _id: storeId, isDelete: false }, { name: 1 }).lean();
    if (!store) throw new NotFoundException('Store not found');
    const ntnCheck = { checkedAt: new Date(), checkedBy: meta.adminId, result };
    await this.r.storeModel.updateOne({ _id: storeId }, {
      $set: { 'verification.ntnCheck': ntnCheck },
      $push: { 'verification.history': { action: 'ntn_checked', note: result, actorId: meta.adminId, actorRole: 'admin', at: new Date() } },
    });
    this.log('seller_trust_ntn_checked', `NTN of store "${store.name}" checked on FBR: ${result}`, meta, storeId);
    return { success: true, message: 'NTN check recorded', data: { ntnCheck } };
  }

  async setPayoutHold(storeId: string, active: boolean, reason: string | undefined, meta: AuditMeta) {
    this.assertStoreId(storeId);
    const store: any = await this.r.storeModel.findOne({ _id: storeId, isDelete: false }, { name: 1 }).lean();
    if (!store) throw new NotFoundException('Store not found');
    const payoutHold = active ? { active: true, reason: reason?.trim() || null, by: meta.adminId, at: new Date() } : null;
    await this.r.storeModel.updateOne({ _id: storeId }, {
      $set: { payoutHold },
      $push: { 'verification.history': { action: active ? 'payout_hold' : 'payout_release', note: payoutHold?.reason ?? null, actorId: meta.adminId, actorRole: 'admin', at: new Date() } },
    });
    this.log(active ? 'seller_trust_payout_hold' : 'seller_trust_payout_hold_released',
      `Payouts of store "${store.name}" ${active ? `put on hold${payoutHold?.reason ? `: ${payoutHold.reason}` : ''}` : 'released'}`, meta, storeId);
    return { success: true, message: active ? 'Payouts on hold' : 'Payout hold released', data: { payoutHold } };
  }

  // ── Reminders ──

  /** Email + in-app reminder to each matching unverified store's seller, at most one per store per 24h. */
  async remind(dto: { storeIds?: string[]; filter?: Partial<SellerTrustQueryDto> }, meta: AuditMeta, now = new Date()) {
    let stores: any[];
    if (dto.storeIds?.length) {
      const ids = dto.storeIds.filter((id) => isValidObjectId(id));
      stores = ids.length ? await this.r.storeModel.find({ _id: { $in: ids }, isDelete: false }, { name: 1, sellerId: 1, verificationStatus: 1, verificationDueAt: 1 }).lean() : [];
    } else if (dto.filter) {
      const match = await this.buildMatch(dto.filter, now);
      stores = await this.r.storeModel.aggregate([{ $match: match }, { $limit: 1000 }, { $project: { name: 1, sellerId: 1, verificationStatus: 1, verificationDueAt: 1 } }]);
    } else {
      throw new BadRequestException('Pass storeIds or filter');
    }

    let sent = 0;
    let skipped = 0;
    for (const store of stores) {
      if (store.verificationStatus === 'verified') { skipped++; continue; }
      // Atomic claim — two admins clicking at once still send one reminder.
      const claim = await this.r.storeModel.updateOne(
        { _id: store._id, verificationStatus: { $ne: 'verified' }, $or: [{ lastTrustReminderAt: null }, { lastTrustReminderAt: { $lte: new Date(now.getTime() - REMINDER_INTERVAL_MS) } }] },
        { $set: { lastTrustReminderAt: now }, $push: { 'verification.history': { action: 'reminder_sent', note: null, actorId: meta.adminId, actorRole: 'admin', at: now } } },
      );
      if (!claim?.modifiedCount) { skipped++; continue; }
      const due = store.verificationDueAt ? new Date(store.verificationDueAt) : null;
      const body = due
        ? (due.getTime() <= now.getTime()
          ? `"${store.name}" is not verified yet, so it is hidden from the Solvexo marketplace and payouts are on hold. Verify your business to lift these limits.`
          : `Verify "${store.name}" by ${due.toISOString().slice(0, 10)} to stay listed on the Solvexo marketplace and keep receiving payouts.`)
        : `Verify "${store.name}" to get the Verified business badge on your store.`;
      await this.notificationsService.notify({
        recipientId: store.sellerId, recipientRole: 'seller', storeId: String(store._id),
        type: NOTIFICATION_TYPES.VERIFICATION_REMINDER, title: 'Verify your business', body,
        data: { storeId: String(store._id) },
      }).catch(() => {});
      sent++;
    }
    this.log('seller_trust_reminders_sent', `Verification reminders sent: ${sent} (skipped ${skipped})`, meta, undefined, { sent, skipped, storeIds: dto.storeIds ?? null });
    return { success: true, message: `${sent} reminder(s) sent`, data: { sent, skipped } };
  }
}
