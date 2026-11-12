/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { AdminConfigService } from '@/admin-config/admin-config.service';
import { SUB_ORDER_SPEND_EXPR } from '@/store/customer-spend.util';
import {
  deadlineInfo, isTrustLimited, payoutBlockReason, verificationDeadline,
  type SellerTrustSettings,
} from './seller-trust-deadline.util';
import { computeStoreRisk, type StoreRiskInput } from './store-risk.util';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StoreOrderStats { orders30d: number; refunds30d: number; avgOrderValue30d: number; orders7d: number; avgOrderValue7d: number }
const EMPTY_STATS: StoreOrderStats = { orders30d: 0, refunds30d: 0, avgOrderValue30d: 0, orders7d: 0, avgOrderValue7d: 0 };

/** Present = a non-empty NTN/tax id on the verification record OR the invoice tax id in Store Settings. */
export function storeHasNtn(store: { taxId?: string | null; verification?: { taxId?: string | null } | null }): boolean {
  const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  return nonEmpty(store?.verification?.taxId) || nonEmpty(store?.taxId);
}

/** Mongo filter equivalent of storeHasNtn (for counts/list filters). */
export const HAS_NTN_FILTER = {
  $or: [
    { 'verification.taxId': { $exists: true, $nin: [null, ''] } },
    { taxId: { $exists: true, $nin: [null, ''] } },
  ],
};

/** Projection of everything the risk/deadline computation reads. */
const TRUST_FIELDS = 'sellerId createdAt country taxId verificationStatus verificationDueAt marketplaceHidden payoutHold verification';

/**
 * Core seller-trust state: enforcement settings, verification deadline,
 * marketplace visibility (`Store.marketplaceHidden`), payout gating and the
 * admin-only risk level. Used by StoreService (seller verification), the
 * admin review actions, FinanceService (payouts) and the daily cron.
 */
@Injectable()
export class SellerTrustService {
  private readonly logger = new Logger(SellerTrustService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly adminConfig: AdminConfigService,
  ) {}

  private get storeModel() { return this.db.repositories.storeModel; }

  getSettings(): Promise<SellerTrustSettings> {
    return this.adminConfig.getSellerTrustSettings();
  }

  async deadlineFor(store: { createdAt?: any; verificationStatus?: string | null }, now = new Date()) {
    return deadlineInfo(store, await this.getSettings(), now);
  }

  /** Throws a 400 with the seller-facing reason when payouts are held for this store. */
  async assertPayoutAllowed(storeId: string, now = new Date()): Promise<void> {
    const reason = await this.getPayoutBlockReason(storeId, now);
    if (reason) throw new BadRequestException(reason);
  }

  async getPayoutBlockReason(storeId: string, now = new Date()): Promise<string | null> {
    const store: any = await this.storeModel.findById(storeId).select('createdAt verificationStatus payoutHold').lean();
    if (!store) return null;
    return payoutBlockReason(store, await this.getSettings(), now);
  }

  // ── Order / report stats for the risk signals ──

  async orderStats(storeIds: string[] | null, now = new Date()): Promise<Map<string, StoreOrderStats>> {
    const since30 = new Date(now.getTime() - 30 * DAY_MS);
    const since7 = new Date(now.getTime() - 7 * DAY_MS);
    const storeMatch = storeIds ? { 'sellerOrders.storeId': { $in: storeIds } } : {};
    const rows: any[] = await this.db.repositories.orderModel.aggregate([
      { $match: { createdAt: { $gte: since30 }, isDelete: { $ne: true }, ...storeMatch } },
      { $unwind: '$sellerOrders' },
      ...(storeIds ? [{ $match: storeMatch }] : []),
      {
        $group: {
          _id: '$sellerOrders.storeId',
          orders30d: { $sum: 1 },
          refunds30d: { $sum: { $cond: [{ $in: ['$sellerOrders.status', ['refunded', 'partially_refunded']] }, 1, 0] } },
          amount30d: { $sum: SUB_ORDER_SPEND_EXPR },
          orders7d: { $sum: { $cond: [{ $gte: ['$createdAt', since7] }, 1, 0] } },
          amount7d: { $sum: { $cond: [{ $gte: ['$createdAt', since7] }, SUB_ORDER_SPEND_EXPR, 0] } },
        },
      },
    ]);
    const map = new Map<string, StoreOrderStats>();
    for (const r of rows) {
      map.set(String(r._id), {
        orders30d: r.orders30d,
        refunds30d: r.refunds30d,
        avgOrderValue30d: r.orders30d ? (r.amount30d ?? 0) / r.orders30d : 0,
        orders7d: r.orders7d,
        avgOrderValue7d: r.orders7d ? (r.amount7d ?? 0) / r.orders7d : 0,
      });
    }
    return map;
  }

  /** Open (unresolved) reports against a seller account or one of a store's listings, counted per store. */
  async openReportCounts(stores: { _id: any; sellerId: string }[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!stores.length) return counts;
    const reports: any[] = await this.db.repositories.reportModel
      .find({ status: { $ne: 'resolved' }, targetType: { $in: ['seller', 'listing'] } }, { targetType: 1, targetId: 1 })
      .lean();
    if (!reports.length) return counts;

    const storeIdsBySeller = new Map<string, string[]>();
    for (const s of stores) {
      const list = storeIdsBySeller.get(String(s.sellerId)) ?? [];
      list.push(String(s._id));
      storeIdsBySeller.set(String(s.sellerId), list);
    }
    const wanted = new Set(stores.map((s) => String(s._id)));
    const listingIds = reports.filter((r) => r.targetType === 'listing').map((r) => r.targetId);
    const products: any[] = listingIds.length
      ? await this.db.repositories.productModel.find({ _id: { $in: listingIds } }, { storeId: 1 }).lean()
      : [];
    const storeByProduct = new Map(products.map((p) => [String(p._id), String(p.storeId)]));
    const bump = (storeId: string) => { if (wanted.has(storeId)) counts.set(storeId, (counts.get(storeId) ?? 0) + 1); };
    for (const r of reports) {
      if (r.targetType === 'seller') (storeIdsBySeller.get(String(r.targetId)) ?? []).forEach(bump);
      else { const sid = storeByProduct.get(String(r.targetId)); if (sid) bump(sid); }
    }
    return counts;
  }

  /** Pure assembly of the trust state for one store document (with `verification` selected). */
  evaluate(store: any, settings: SellerTrustSettings, stats: StoreOrderStats, openReports: number, now = new Date()) {
    const dueAt = verificationDeadline(store, settings);
    const limited = isTrustLimited(store, settings, now);
    const v = store.verification ?? {};
    const input: StoreRiskInput = {
      verificationStatus: store.verificationStatus ?? 'not_started',
      deadlinePassed: limited,
      country: store.country ?? 'PK',
      hasNtn: storeHasNtn(store),
      businessProfile: v.businessProfile ?? null,
      documentTypes: (v.documents ?? []).map((d: any) => d.type),
      createdAt: store.createdAt ?? null,
      now,
      ...stats,
      openReports,
    };
    const risk = computeStoreRisk(input);
    return { dueAt, limited, risk };
  }

  /** Recomputes and saves one store's deadline, marketplace visibility and risk. Never throws. */
  async recomputeStore(storeId: string, now = new Date()) {
    try {
      const store: any = await this.storeModel.findOne({ _id: storeId, isDelete: false }).select(TRUST_FIELDS).lean();
      if (!store) return null;
      const [settings, statsMap, reportMap] = await Promise.all([
        this.getSettings(),
        this.orderStats([String(store._id)], now),
        this.openReportCounts([store]),
      ]);
      const { dueAt, limited, risk } = this.evaluate(store, settings, statsMap.get(String(store._id)) ?? EMPTY_STATS, reportMap.get(String(store._id)) ?? 0, now);
      await this.storeModel.updateOne({ _id: store._id }, {
        $set: { verificationDueAt: dueAt, marketplaceHidden: limited, riskLevel: risk.level, riskReasons: risk.reasons, riskUpdatedAt: now },
      });
      return { dueAt, limited, risk };
    } catch (err: any) {
      this.logger.warn(`recomputeStore(${storeId}) failed: ${err?.message}`);
      return null;
    }
  }

  /** Daily cron: every non-deleted store. Stats are aggregated once for the whole platform. */
  async recomputeAll(now = new Date()): Promise<{ stores: number; high: number; medium: number; hidden: number }> {
    const [settings, statsMap] = await Promise.all([this.getSettings(), this.orderStats(null, now)]);
    const stores: any[] = await this.storeModel.find({ isDelete: false }).select(TRUST_FIELDS).lean();
    const reportMap = await this.openReportCounts(stores);
    let high = 0; let medium = 0; let hidden = 0;
    const ops: any[] = [];
    for (const store of stores) {
      const id = String(store._id);
      const { dueAt, limited, risk } = this.evaluate(store, settings, statsMap.get(id) ?? EMPTY_STATS, reportMap.get(id) ?? 0, now);
      if (risk.level === 'high') high++; else if (risk.level === 'medium') medium++;
      if (limited) hidden++;
      ops.push({ updateOne: { filter: { _id: store._id }, update: { $set: { verificationDueAt: dueAt, marketplaceHidden: limited, riskLevel: risk.level, riskReasons: risk.reasons, riskUpdatedAt: now } } } });
      if (ops.length >= 500) await this.storeModel.bulkWrite(ops.splice(0));
    }
    if (ops.length) await this.storeModel.bulkWrite(ops);
    return { stores: stores.length, high, medium, hidden };
  }

  /**
   * Cheap set-based sync of `verificationDueAt` + `marketplaceHidden` for every
   * store — run right after enforcement starts/stops or the grace period
   * changes, and hourly so a deadline passing takes effect within the hour.
   */
  async syncDeadlines(now = new Date()): Promise<void> {
    const settings = await this.getSettings();
    if (!settings.enforcementStartedAt) {
      await this.storeModel.updateMany({ $or: [{ verificationDueAt: { $ne: null } }, { marketplaceHidden: true }] }, { $set: { verificationDueAt: null, marketplaceHidden: false } });
      return;
    }
    const start = new Date(settings.enforcementStartedAt);
    const graceDue = new Date(start.getTime() + settings.graceDays * DAY_MS);
    await this.storeModel.updateMany({ isDelete: false, createdAt: { $lt: start } }, { $set: { verificationDueAt: graceDue } });
    // Pipeline update: a store created after enforcement started is due at its own createdAt.
    await this.storeModel.updateMany({ isDelete: false, createdAt: { $gte: start } }, [{ $set: { verificationDueAt: '$createdAt' } }] as any);
    await this.syncMarketplaceHidden(now);
  }

  /** Flips `marketplaceHidden` from the stored `verificationDueAt` (both directions). */
  async syncMarketplaceHidden(now = new Date()): Promise<void> {
    await this.storeModel.updateMany(
      { isDelete: false, verificationStatus: { $ne: 'verified' }, verificationDueAt: { $ne: null, $lte: now }, marketplaceHidden: { $ne: true } },
      { $set: { marketplaceHidden: true } },
    );
    await this.storeModel.updateMany(
      { marketplaceHidden: true, $or: [{ verificationStatus: 'verified' }, { verificationDueAt: null }, { verificationDueAt: { $gt: now } }] },
      { $set: { marketplaceHidden: false } },
    );
  }

  /** New store: stamps its deadline right away (a store created after enforcement started is limited immediately). */
  async onStoreCreated(storeId: string, createdAt: Date, now = new Date()): Promise<void> {
    try {
      const settings = await this.getSettings();
      if (!settings.enforcementStartedAt) return;
      const store = { createdAt, verificationStatus: 'not_started' };
      await this.storeModel.updateOne({ _id: storeId }, {
        $set: { verificationDueAt: verificationDeadline(store, settings), marketplaceHidden: isTrustLimited(store, settings, now) },
      });
    } catch (err: any) {
      this.logger.warn(`onStoreCreated(${storeId}) failed: ${err?.message}`);
    }
  }
}

/** The per-store trust columns the admin lists show, from a store doc that has
 *  `verificationStatus verificationDueAt riskLevel riskReasons payoutHold taxId verification.taxId`. */
export function storeTrustSnapshot(store: any, now = new Date()) {
  const verificationStatus = store?.verificationStatus ?? 'not_started';
  const dueAt: Date | null = store?.verificationDueAt ? new Date(store.verificationDueAt) : null;
  return {
    hasNtn: storeHasNtn(store),
    ntn: (store?.verification?.taxId || store?.taxId || null) as string | null,
    verificationStatus,
    riskLevel: (store?.riskLevel ?? 'low') as 'low' | 'medium' | 'high',
    riskReasons: (store?.riskReasons ?? []) as { code: string; label: string; severity: string }[],
    dueAt,
    limited: verificationStatus !== 'verified' && !!dueAt && now.getTime() >= dueAt.getTime(),
    payoutHold: store?.payoutHold?.active ? store.payoutHold : null,
  };
}
