/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { FinanceService } from '../finance/finance.service';
import { resolveDateRange, enumerateBuckets } from '../analytics/utils/analytics-date.util';
import { round } from '../common/number.util';
import { buildAnalyticsCacheKey, withAnalyticsCache } from '../analytics/utils/analytics-cache.util';
import { getPlatformEarnings } from '../common/platform-earnings.util';
import { toCsv } from '../analytics/utils/csv.util';
import { PdfReportBuilder } from '../analytics/utils/pdf-report.util';

const CACHE_TTL_SECONDS = 600; // 10 minutes — same convention as admin/seller analytics

/**
 * Platform-wide finance oversight for admins. Read-heavy platform aggregations
 * (overview, revenue/commission trends, seller-balance listing, reports) are
 * implemented here directly against `DatabaseService.repositories` — the same
 * split used for `AdminAnalyticsService` vs seller `AnalyticsService`. Anything
 * that mutates a payout or a seller's balance delegates to `FinanceService`
 * (`adminApprovePayout`, `adminRejectPayout`, etc.) so that ledger-writing logic
 * exists exactly once, shared with the seller-facing endpoints.
 */
@Injectable()
export class AdminFinanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly financeService: FinanceService,
  ) {}

  private get r() {
    return this.db.repositories;
  }

  private async cached<T>(cacheKey: string, compute: () => Promise<T>): Promise<T> {
    return withAnalyticsCache(this.redis, cacheKey, CACHE_TTL_SECONDS, compute);
  }

  private key(section: string, query: Record<string, any>) {
    return buildAnalyticsCacheKey('admin-finance', 'platform', section, query);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // A. DASHBOARD OVERVIEW
  // ═══════════════════════════════════════════════════════════════════════

  async getOverview(query: any) {
    const { from, to } = resolveDateRange(query);

    return this.cached(this.key('overview', { from, to }), async () => {
      const [byTypeRows, balanceTotalsRows, payoutStatusRows, sellersWithBalance, earnings, flaggedSellersCount, pendingVerificationMethodsCount, pendingManualPaymentsCount] = await Promise.all([
        this.r.transactionModel.aggregate([
          { $match: { status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } } },
          { $group: { _id: '$type', total: { $sum: { $abs: '$amount' } }, count: { $sum: 1 } } },
        ]),
        this.r.sellerBalanceModel.aggregate([
          {
            $group: {
              _id: null,
              totalAvailable: { $sum: '$availableBalance' },
              totalPending: { $sum: '$pendingBalance' },
              totalRevenue: { $sum: '$totalRevenue' },
              totalFees: { $sum: '$totalFees' },
              totalRefunds: { $sum: '$totalRefunds' },
              totalPayouts: { $sum: '$totalPayouts' },
            },
          },
        ]),
        this.r.payoutModel.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
        this.r.sellerBalanceModel.countDocuments({}),
        getPlatformEarnings(this.r.transactionModel, this.r.subscriptionInvoiceModel, from, to),
        this.r.sellerBalanceModel.countDocuments({ isFlaggedForReview: true }),
        this.r.payoutMethodModel.countDocuments({ status: 'pending_verification' }),
        this.r.manualPaymentProofModel.countDocuments({ status: 'pending' }),
      ]);

      const byType: Record<string, { total: number; count: number }> = {};
      for (const row of byTypeRows) byType[row._id] = { total: round(row.total), count: row.count };

      const gmv = byType.sale?.total ?? 0;
      const refunds = byType.refund?.total ?? 0;

      const payoutQueue: Record<string, { count: number; amount: number }> = {
        pending: { count: 0, amount: 0 }, processing: { count: 0, amount: 0 },
        completed: { count: 0, amount: 0 }, failed: { count: 0, amount: 0 },
      };
      for (const row of payoutStatusRows) {
        if (payoutQueue[row._id]) payoutQueue[row._id] = { count: row.count, amount: round(row.amount) };
      }

      const balances = balanceTotalsRows[0] ?? { totalAvailable: 0, totalPending: 0, totalRevenue: 0, totalFees: 0, totalRefunds: 0, totalPayouts: 0 };

      return {
        success: true,
        data: {
          period: { from, to },
          gmv,
          netRevenue: round(gmv - refunds),
          refunds,
          totalOrders: byType.sale?.count ?? 0,
          platformEarnings: earnings.total,
          platformCommission: earnings.commission,
          subscriptionRevenue: earnings.subscriptionRevenue,
          paymentProcessingFees: earnings.processingFees,
          sellerBalances: {
            totalAvailable: round(balances.totalAvailable),
            totalPending: round(balances.totalPending),
            sellersWithBalance,
          },
          flaggedSellersCount,
          pendingVerificationMethodsCount,
          pendingManualPaymentsCount,
          lifetimeTotals: {
            totalRevenue: round(balances.totalRevenue),
            totalFees: round(balances.totalFees),
            totalRefunds: round(balances.totalRefunds),
            totalPayouts: round(balances.totalPayouts),
          },
          payoutQueue,
          note: '"gmv"/"netRevenue"/"refunds" are scoped to the selected period. "sellerBalances" and "lifetimeTotals" are current, all-time snapshots regardless of the date filter — they answer "what does the platform currently hold/owe", not "in this period".',
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // B. PLATFORM REVENUE / COMMISSION TRENDS
  // ═══════════════════════════════════════════════════════════════════════

  async getRevenueOverTime(query: any) {
    const { from, to, granularity } = resolveDateRange(query);

    return this.cached(this.key('revenue-over-time', { from, to, granularity }), async () => {
      const rows = await this.r.transactionModel.aggregate([
        { $match: { type: { $in: ['sale', 'refund'] }, status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } } },
        { $addFields: { bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } } } },
        { $group: { _id: { bucket: '$bucket', type: '$type' }, total: { $sum: { $abs: '$amount' } } } },
      ]);

      const byBucket = new Map<number, { gross: number; refunds: number }>();
      for (const row of rows) {
        const t = row._id.bucket.getTime();
        const entry = byBucket.get(t) ?? { gross: 0, refunds: 0 };
        if (row._id.type === 'sale') entry.gross = row.total; else entry.refunds = row.total;
        byBucket.set(t, entry);
      }

      const series = enumerateBuckets(from, to, granularity).map((bucket) => {
        const e = byBucket.get(bucket.getTime()) ?? { gross: 0, refunds: 0 };
        return { date: bucket, grossRevenue: round(e.gross), netRevenue: round(e.gross - e.refunds) };
      });

      return { success: true, data: { granularity, series } };
    });
  }

  async getCommissionOverTime(query: any) {
    const { from, to, granularity } = resolveDateRange(query);

    return this.cached(this.key('commission-over-time', { from, to, granularity }), async () => {
      const rows = await this.r.transactionModel.aggregate([
        { $match: { type: 'sale', status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } } },
        { $addFields: { bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } } } },
        { $group: { _id: '$bucket', commission: { $sum: '$metadata.platformFee' }, processingFees: { $sum: '$metadata.processingFee' } } },
      ]);

      const byBucket = new Map(rows.map((r: any) => [r._id.getTime(), r]));
      const series = enumerateBuckets(from, to, granularity).map((bucket) => {
        const row = byBucket.get(bucket.getTime());
        return { date: bucket, commission: round(row?.commission ?? 0), processingFees: round(row?.processingFees ?? 0) };
      });

      return { success: true, data: { granularity, series } };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // C. SELLER BALANCES
  // ═══════════════════════════════════════════════════════════════════════

  async getSellerBalances(query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const sort = ['availableBalance', 'pendingBalance', 'totalRevenue', 'totalPayouts'].includes(query.sort) ? query.sort : 'availableBalance';
    const order = query.order === 'asc' ? 1 : -1;

    return this.cached(this.key('seller-balances', { page, limit, sort, order, search: query.search ?? '', flaggedOnly: query.flaggedOnly ?? '' }), async () => {
      const balances = await this.r.sellerBalanceModel.find({}).lean();
      const sellerIds = [...new Set(balances.map((b: any) => b.sellerId))];
      const storeIds = balances.map((b: any) => b.storeId);

      const [sellers, stores] = await Promise.all([
        this.r.sellerModel.find({ _id: { $in: sellerIds } }).select('name email').lean(),
        this.r.storeModel.find({ _id: { $in: storeIds } }).select('name').lean(),
      ]);
      const sellerMap = new Map(sellers.map((s: any) => [s._id.toString(), s]));
      const storeMap = new Map(stores.map((s: any) => [s._id.toString(), s]));

      let rows = balances.map((b: any) => ({
        storeId: b.storeId,
        storeName: storeMap.get(b.storeId)?.name ?? 'Unknown store',
        sellerId: b.sellerId,
        sellerName: sellerMap.get(b.sellerId)?.name ?? 'Unknown seller',
        sellerEmail: sellerMap.get(b.sellerId)?.email ?? '',
        availableBalance: b.availableBalance,
        pendingBalance: b.pendingBalance,
        totalRevenue: b.totalRevenue,
        totalFees: b.totalFees,
        totalRefunds: b.totalRefunds,
        totalPayouts: b.totalPayouts,
        currency: b.currency,
        isFlaggedForReview: b.isFlaggedForReview ?? false,
        flaggedReason: b.flaggedReason ?? null,
      }));

      if (query.search) {
        const q = String(query.search).toLowerCase();
        rows = rows.filter((r) => r.sellerName.toLowerCase().includes(q) || r.sellerEmail.toLowerCase().includes(q) || r.storeName.toLowerCase().includes(q));
      }

      if (query.flaggedOnly === 'true' || query.flaggedOnly === true) {
        rows = rows.filter((r) => r.isFlaggedForReview);
      }

      rows.sort((a: any, b: any) => order * (a[sort] - b[sort]));

      const total = rows.length;
      const start = (page - 1) * limit;

      return {
        success: true,
        data: {
          pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
          sellers: rows.slice(start, start + limit),
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // D. SELLER DRILL-DOWN — delegates to FinanceService (no ledger logic duplicated)
  // ═══════════════════════════════════════════════════════════════════════

  async getSellerFinancialDetails(storeId: string) {
    const data = await this.financeService.adminGetSellerFinancialDetails(storeId);
    return { success: true, data };
  }

  async getSellerTransactions(storeId: string, query: any) {
    const data = await this.financeService.adminGetSellerTransactions(storeId, query);
    return { success: true, data };
  }

  /** Joins `storeName` onto rows that only carry a bare `storeId` — a display-layer concern, kept out of `FinanceService` since seller-facing endpoints never need it (a seller already knows their own store's name). */
  private async attachStoreNames<T extends { storeId: string }>(rows: T[]): Promise<Array<T & { storeName: string }>> {
    if (rows.length === 0) return [];
    const storeIds = [...new Set(rows.map((r) => r.storeId))];
    const stores = await this.r.storeModel.find({ _id: { $in: storeIds } }).select('name').lean();
    const storeMap = new Map(stores.map((s: any) => [s._id.toString(), s.name as string]));
    return rows.map((r) => ({ ...r, storeName: storeMap.get(r.storeId) ?? 'Unknown store' }));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // E. PLATFORM TRANSACTIONS — delegates to FinanceService, enriched with store names
  // ═══════════════════════════════════════════════════════════════════════

  async getPlatformTransactions(query: any) {
    const data = await this.financeService.adminGetPlatformTransactions(query);
    const transactions = await this.attachStoreNames(data.transactions as any[]);
    return { success: true, data: { ...data, transactions } };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F. PAYOUT QUEUE & LIFECYCLE — delegates to FinanceService, enriched with store names
  // ═══════════════════════════════════════════════════════════════════════

  async getPayoutQueue(query: any) {
    const data = await this.financeService.adminGetPayoutQueue(query);
    const payouts = await this.attachStoreNames(data.payouts as any[]);
    return { success: true, data: { ...data, payouts } };
  }

  async approvePayout(payoutId: string, adminId: string, ip?: string, userAgent?: string) {
    const data = await this.financeService.adminApprovePayout(payoutId, adminId, ip, userAgent);
    return { success: true, data };
  }

  async rejectPayout(payoutId: string, adminId: string, reason: string, ip?: string, userAgent?: string) {
    const data = await this.financeService.adminRejectPayout(payoutId, adminId, reason, ip, userAgent);
    return { success: true, data };
  }

  async retryPayout(payoutId: string, adminId: string, ip?: string, userAgent?: string) {
    const data = await this.financeService.adminRetryFailedPayout(payoutId, adminId, ip, userAgent);
    return { success: true, data };
  }

  async createManualPayout(storeId: string, adminId: string, amount: number, payoutMethodId: string | undefined, notes: string | undefined, ip?: string, userAgent?: string) {
    const data = await this.financeService.adminCreateManualPayout(storeId, adminId, amount, payoutMethodId, notes, ip, userAgent);
    return { success: true, data };
  }

  async triggerClearingBalances() {
    const data = await this.financeService.processClearingBalances();
    return { success: true, data };
  }

  async triggerScheduledPayouts() {
    const data = await this.financeService.processScheduledPayouts();
    return { success: true, data };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PAYOUT METHOD VERIFICATION — every new method starts 'pending_verification'
  // (see PayoutMethod schema) since no automated bank/wallet verification
  // exists yet; an admin must review and activate it before a seller can
  // withdraw to it.
  // ═══════════════════════════════════════════════════════════════════════

  async getPendingVerificationMethods() {
    const methods = await this.r.payoutMethodModel.find({ status: 'pending_verification' }).sort({ createdAt: 1 }).lean();
    const enriched = await this.attachStoreNames(methods as any[]);
    return { success: true, data: enriched };
  }

  async verifyPayoutMethod(storeId: string, methodId: string, adminId: string, approve: boolean, note?: string) {
    const data = await this.financeService.adminVerifyPayoutMethod(storeId, methodId, adminId, approve, note);
    return { success: true, data };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // G. REPORTS
  // ═══════════════════════════════════════════════════════════════════════

  async getRefundReport(query: any) {
    const { from, to } = resolveDateRange(query);

    return this.cached(this.key('refunds', { from, to }), async () => {
      const refundRows = await this.r.transactionModel.aggregate([
        { $match: { type: 'refund', createdAt: { $gte: from, $lte: to } } },
        { $group: { _id: '$storeId', totalRefunded: { $sum: { $abs: '$amount' } }, count: { $sum: 1 } } },
      ]);

      const storeIds = (refundRows).map((r) => r._id);
      const stores = await this.r.storeModel.find({ _id: { $in: storeIds } }).select('name').lean();
      const storeMap = new Map(stores.map((s: any) => [s._id.toString(), s]));

      const byStore = (refundRows)
        .map((r) => ({ storeId: r._id, storeName: storeMap.get(r._id)?.name ?? 'Unknown store', totalRefunded: round(r.totalRefunded), count: r.count }))
        .sort((a, b) => b.totalRefunded - a.totalRefunded);

      return {
        success: true,
        data: {
          period: { from, to },
          totalRefunded: round(byStore.reduce((s, r) => s + r.totalRefunded, 0)),
          totalRefundCount: byStore.reduce((s, r) => s + r.count, 0),
          byStore,
          note: 'Platform commission is not clawed back when a refund is issued (see finance.service.ts#recordRefund — only the seller\'s balance is debited) — the platform keeps its original commission on refunded sales. This report shows refund volume only, not a commission adjustment.',
        },
      };
    });
  }

  async getTaxReports(query: any) {
    const filter: Record<string, any> = {};
    if (query.storeId) filter.storeId = query.storeId;
    if (query.year) filter.year = Number(query.year);

    const reports = await this.r.taxReportModel.find(filter).sort({ year: -1, period: 1 }).limit(200).lean();
    const storeIds = [...new Set(reports.map((r: any) => r.storeId))];
    const stores = await this.r.storeModel.find({ _id: { $in: storeIds } }).select('name').lean();
    const storeMap = new Map(stores.map((s: any) => [s._id.toString(), s]));

    return {
      success: true,
      data: reports.map((r: any) => ({ ...r, storeName: storeMap.get(r.storeId)?.name ?? 'Unknown store' })),
    };
  }

  async getSettlementReport(query: any) {
    const { from, to } = resolveDateRange(query);

    return this.cached(this.key('settlement', { from, to }), async () => {
      const [byTypeRows, balanceTotalsRows] = await Promise.all([
        this.r.transactionModel.aggregate([
          { $match: { status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } } },
          { $group: { _id: '$type', total: { $sum: { $abs: '$amount' } } } },
        ]),
        this.r.sellerBalanceModel.aggregate([{ $group: { _id: null, totalAvailable: { $sum: '$availableBalance' }, totalPending: { $sum: '$pendingBalance' } } }]),
      ]);

      const stats: Record<string, number> = { sale: 0, fee: 0, refund: 0, payout: 0, adjustment: 0 };
      for (const row of byTypeRows) stats[row._id] = round(row.total);
      const balances = balanceTotalsRows[0] ?? { totalAvailable: 0, totalPending: 0 };

      return {
        success: true,
        data: {
          period: { from, to },
          grossSales: stats.sale,
          platformFeesCollected: stats.fee,
          refundsIssued: stats.refund,
          payoutsDisbursed: stats.payout,
          adjustments: stats.adjustment,
          outstandingObligation: {
            availableBalance: round(balances.totalAvailable),
            pendingBalance: round(balances.totalPending),
            totalOwedToSellers: round(balances.totalAvailable + balances.totalPending),
          },
          note: '"outstandingObligation" is a current snapshot (not scoped to the selected period) — it answers "if every seller withdrew today, how much would leave the platform".',
        },
      };
    });
  }

  async getMonthlyReport(query: any) {
    const months = Math.min(12, Number(query.months) || 6);
    const now = new Date();

    return this.cached(this.key('monthly', { months }), async () => {
      const monthly: Array<Record<string, any>> = [];

      for (let i = months - 1; i >= 0; i--) {
        const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const to = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);

        const [byTypeRows, earnings] = await Promise.all([
          this.r.transactionModel.aggregate([
            { $match: { status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } } },
            { $group: { _id: '$type', total: { $sum: { $abs: '$amount' } } } },
          ]),
          getPlatformEarnings(this.r.transactionModel, this.r.subscriptionInvoiceModel, from, to),
        ]);

        const stats: Record<string, number> = { sale: 0, fee: 0, refund: 0, payout: 0 };
        for (const row of byTypeRows) stats[row._id] = round(row.total);

        monthly.push({
          month: from.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
          gmv: stats.sale,
          refunds: stats.refund,
          payouts: stats.payout,
          platformCommission: earnings.commission,
          subscriptionRevenue: earnings.subscriptionRevenue,
          platformEarnings: earnings.total,
        });
      }

      return { success: true, data: { monthly } };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // H. EXPORT
  // ═══════════════════════════════════════════════════════════════════════

  async exportCsv(query: any): Promise<string> {
    const section = query.section ?? 'transactions';

    switch (section) {
      case 'payouts': {
        const { from, to } = resolveDateRange(query);
        const rows = await this.r.payoutModel.find({ createdAt: { $gte: from, $lte: to } }).sort({ createdAt: -1 }).limit(5000).lean();
        return toCsv(
          ['Payout ID', 'Store ID', 'Amount', 'Status', 'Method', 'Requested At', 'Processed At'],
          (rows as any[]).map((p) => [
            p._id.toString(), p.storeId, p.amount.toFixed(2), p.status, p.payoutMethodSnapshot?.type ?? '',
            new Date(p.createdAt).toISOString().split('T')[0],
            p.processedAt ? new Date(p.processedAt).toISOString().split('T')[0] : '',
          ]),
        );
      }
      case 'sellers': {
        const data = await this.getSellerBalances({ ...query, page: 1, limit: 5000 });
        return toCsv(
          ['Store', 'Seller', 'Email', 'Available', 'Pending', 'Total Revenue', 'Total Payouts'],
          data.data.sellers.map((s: any) => [s.storeName, s.sellerName, s.sellerEmail, s.availableBalance.toFixed(2), s.pendingBalance.toFixed(2), s.totalRevenue.toFixed(2), s.totalPayouts.toFixed(2)]),
        );
      }
      case 'refunds': {
        const report = await this.getRefundReport(query);
        return toCsv(
          ['Store', 'Total Refunded', 'Count'],
          report.data.byStore.map((r: any) => [r.storeName, r.totalRefunded.toFixed(2), r.count]),
        );
      }
      case 'tax': {
        const reports = await this.getTaxReports(query);
        return toCsv(
          ['Store', 'Year', 'Period', 'Revenue', 'Fees', 'Refunds', 'Net', 'Estimated Tax'],
          reports.data.map((r: any) => [r.storeName, r.year, r.period, r.totalRevenue.toFixed(2), r.totalFees.toFixed(2), r.totalRefunds.toFixed(2), r.netRevenue.toFixed(2), r.estimatedTax.toFixed(2)]),
        );
      }
      case 'settlement': {
        const s = await this.getSettlementReport(query);
        return toCsv(['Metric', 'Amount'], [
          ['Gross Sales', s.data.grossSales.toFixed(2)],
          ['Platform Fees Collected', s.data.platformFeesCollected.toFixed(2)],
          ['Refunds Issued', s.data.refundsIssued.toFixed(2)],
          ['Payouts Disbursed', s.data.payoutsDisbursed.toFixed(2)],
          ['Available Balance (owed)', s.data.outstandingObligation.availableBalance.toFixed(2)],
          ['Pending Balance (owed)', s.data.outstandingObligation.pendingBalance.toFixed(2)],
        ]);
      }
      case 'transactions':
      default:
        return this.financeService.adminExportTransactionsCsv(query);
    }
  }

  async exportPdf(query: any): Promise<Buffer> {
    const { from, to } = resolveDateRange(query);

    const [overview, settlement, refunds] = await Promise.all([
      this.getOverview(query),
      this.getSettlementReport(query),
      this.getRefundReport(query),
    ]);

    const rangeLabel = `${from.toISOString().split('T')[0]} to ${to.toISOString().split('T')[0]}`;
    const pdf = await PdfReportBuilder.create('Solvexo — Platform Finance Report', `Period: ${rangeLabel}`);

    pdf.addSectionHeading('Overview');
    pdf.addKeyValueGrid([
      { label: 'GMV', value: `$${overview.data.gmv.toFixed(2)}` },
      { label: 'Net Revenue', value: `$${overview.data.netRevenue.toFixed(2)}` },
      { label: 'Platform Commission', value: `$${overview.data.platformCommission.toFixed(2)}` },
      { label: 'Subscription Revenue', value: `$${overview.data.subscriptionRevenue.toFixed(2)}` },
      { label: 'Total Available (owed to sellers)', value: `$${overview.data.sellerBalances.totalAvailable.toFixed(2)}` },
      { label: 'Total Pending (owed to sellers)', value: `$${overview.data.sellerBalances.totalPending.toFixed(2)}` },
    ]);

    pdf.addSectionHeading('Settlement');
    pdf.addTable(['Metric', 'Amount'], [
      ['Gross Sales', `$${settlement.data.grossSales.toFixed(2)}`],
      ['Platform Fees Collected', `$${settlement.data.platformFeesCollected.toFixed(2)}`],
      ['Refunds Issued', `$${settlement.data.refundsIssued.toFixed(2)}`],
      ['Payouts Disbursed', `$${settlement.data.payoutsDisbursed.toFixed(2)}`],
    ]);

    pdf.addSectionHeading('Refunds by Store');
    if (refunds.data.byStore.length > 0) {
      pdf.addTable(
        ['Store', 'Total Refunded', 'Count'],
        refunds.data.byStore.slice(0, 20).map((r: any) => [r.storeName, `$${r.totalRefunded.toFixed(2)}`, r.count]),
      );
    } else {
      pdf.addEmptyNote('No refunds recorded in this period.');
    }

    return pdf.build();
  }
}
