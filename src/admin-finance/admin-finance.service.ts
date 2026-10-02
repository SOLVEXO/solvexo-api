/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { FinanceService } from '../finance/finance.service';
import { resolveDateRange, enumerateBuckets } from '../analytics/utils/analytics-date.util';
import { round } from '../common/number.util';
import { buildAnalyticsCacheKey, withAnalyticsCache } from '../analytics/utils/analytics-cache.util';
import { getPlatformEarnings } from '../common/platform-earnings.util';
import { toCsv } from '../analytics/utils/csv.util';
import { PdfReportBuilder } from '../analytics/utils/pdf-report.util';
import { AdminConfigService } from '../admin-config/admin-config.service';
import { ActivityLogService } from '../activity-log/activity-log.service';

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
    private readonly adminConfigService: AdminConfigService,
    private readonly activityLogService: ActivityLogService,
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

  /**
   * Latest accepted rate per currency (units of that currency per 1 USD).
   * USD is always 1. Used to roll the per-currency ledger up into a single
   * USD figure for the platform owner — Solvexo's own books are USD (Stripe);
   * PKR rows exist only because some sellers' stores settle in PKR.
   */
  private async getUsdRates(): Promise<Map<string, number>> {
    const rates = await this.r.exchangeRateModel.aggregate([
      { $match: { isRejected: false } },
      { $sort: { effectiveFrom: -1 } },
      { $group: { _id: '$currency', ratePerUSD: { $first: '$ratePerUSD' } } },
    ]);
    const map = new Map<string, number>(rates.map((r: any) => [r._id, r.ratePerUSD]));
    map.set('USD', 1);
    return map;
  }

  /** `null` when no rate is known — callers must disclose, never guess. */
  private toUsd(amount: number, currency: string, rates: Map<string, number>): number | null {
    const rate = rates.get(currency);
    return rate && rate > 0 ? amount / rate : null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // A0. PLATFORM REVENUE — what sellers pay Solvexo (Shopify's own revenue lines)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * What the platform itself earns, USD only (admin never sees a store's currency here):
   *  1. Plans & subscriptions — paid platform-plan invoices, net of refunds.
   *  2. Third-party transaction fees — collected on sellers' monthly bills
   *     (TransactionFeeBill); also shows what is invoiced-but-unpaid and what has
   *     accrued but not been billed yet, so nothing is overstated.
   * Card payments are NOT a revenue line: they settle straight into the seller's
   * connected account and the card-network cost is passed through.
   */
  async getPlatformRevenue(query: any) {
    const { from, to } = resolveDateRange(query);

    return this.cached(this.key('platform-revenue-v1', { from, to }), async () => {
      const [planRows, paidBillRows, openBillRows, accruedRows, rates] = await Promise.all([
        this.r.platformPlanInvoiceModel.aggregate([
          { $match: { status: { $in: ['paid', 'partially_refunded', 'refunded'] }, isDelete: false, paidAt: { $gte: from, $lte: to } } },
          { $group: { _id: null, gross: { $sum: '$amountUSD' }, refunded: { $sum: '$refundedAmountUSD' }, count: { $sum: 1 } } },
        ]),
        this.r.transactionFeeBillModel.aggregate([
          { $match: { status: 'paid', isDelete: false, paidAt: { $gte: from, $lte: to } } },
          { $group: { _id: null, total: { $sum: '$amountUSD' }, count: { $sum: 1 } } },
        ]),
        this.r.transactionFeeBillModel.aggregate([
          { $match: { status: { $in: ['invoiced', 'payment_failed'] }, isDelete: false, createdAt: { $gte: from, $lte: to } } },
          { $group: { _id: null, total: { $sum: '$amountUSD' }, count: { $sum: 1 } } },
        ]),
        this.r.transactionModel.aggregate([
          { $match: { type: 'fee', 'metadata.billing.status': 'pending_invoice' } },
          { $group: { _id: '$currency', amount: { $sum: { $abs: '$amount' } } } },
        ]),
        this.getUsdRates(),
      ]);

      const planGross = round(planRows[0]?.gross ?? 0);
      const planRefunded = round(planRows[0]?.refunded ?? 0);
      const planNet = round(planGross - planRefunded);
      const feesCollected = round(paidBillRows[0]?.total ?? 0);
      const feesInvoicedUnpaid = round(openBillRows[0]?.total ?? 0);

      // Accrued-but-unbilled fees accrue in each seller's own currency — convert at the latest rate
      // and DISCLOSE any currency with no known rate instead of guessing.
      let accruedUnbilled = 0;
      const unconvertibleCurrencies: string[] = [];
      for (const row of accruedRows as any[]) {
        const usd = this.toUsd(row.amount ?? 0, row._id ?? 'USD', rates);
        if (usd === null) unconvertibleCurrencies.push(row._id);
        else accruedUnbilled += usd;
      }

      return {
        success: true,
        data: {
          currency: 'USD',
          range: { from, to },
          planRevenue: { grossUSD: planGross, refundedUSD: planRefunded, netUSD: planNet, invoiceCount: planRows[0]?.count ?? 0 },
          transactionFees: {
            collectedUSD: feesCollected,
            billCount: paidBillRows[0]?.count ?? 0,
            invoicedUnpaidUSD: feesInvoicedUnpaid,
            accruedUnbilledUSD: round(accruedUnbilled),
            ...(unconvertibleCurrencies.length ? { unconvertibleCurrencies } : {}),
          },
          totalRevenueUSD: round(planNet + feesCollected),
          note: 'Revenue = what sellers pay Solvexo: platform plans (net of refunds) + third-party transaction fees collected on their monthly bills. "invoicedUnpaidUSD" and "accruedUnbilledUSD" are NOT counted until collected. Buyer card payments settle directly into the seller\'s own connected account and are not platform revenue.',
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // A. DASHBOARD OVERVIEW
  // ═══════════════════════════════════════════════════════════════════════

  async getOverview(query: any) {
    const { from, to } = resolveDateRange(query);

    return this.cached(this.key('overview-v2', { from, to }), async () => {
      const [byTypeRows, balanceTotalsRows, payoutStatusRows, sellersWithBalance, earnings, flaggedSellersCount, pendingVerificationMethodsCount, pendingManualPaymentsCount] = await Promise.all([
        // `currency` is included in the group key — PKR and USD transactions
        // must never be summed into one blended gmv/refunds/netRevenue figure.
        this.r.transactionModel.aggregate([
          { $match: { status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } } },
          { $group: { _id: { type: '$type', currency: '$currency' }, total: { $sum: { $abs: '$amount' } }, count: { $sum: 1 } } },
        ]),
        this.r.sellerBalanceModel.aggregate([
          {
            $group: {
              _id: '$currency',
              totalAvailable: { $sum: '$availableBalance' },
              totalPending: { $sum: '$pendingBalance' },
              totalRevenue: { $sum: '$totalRevenue' },
              totalFees: { $sum: '$totalFees' },
              totalRefunds: { $sum: '$totalRefunds' },
              totalPayouts: { $sum: '$totalPayouts' },
            },
          },
        ]),
        this.r.payoutModel.aggregate([{ $group: { _id: { status: '$status', currency: '$currency' }, count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
        this.r.sellerBalanceModel.countDocuments({}),
        getPlatformEarnings(this.r.transactionModel, from, to),
        this.r.sellerBalanceModel.countDocuments({ isFlaggedForReview: true }),
        this.r.payoutMethodModel.countDocuments({ status: 'pending_verification' }),
        this.r.manualPaymentProofModel.countDocuments({ status: 'pending' }),
      ]);

      const currencies = new Set<string>((await this.adminConfigService.getEnabledCurrencies()).map((c) => c.code));
      for (const row of byTypeRows) currencies.add(row._id.currency ?? 'USD');
      for (const row of balanceTotalsRows) currencies.add(row._id ?? 'USD');

      const balancesByCurrency = new Map(balanceTotalsRows.map((r: any) => [r._id ?? 'USD', r]));
      const earningsByCurrency = new Map(earnings.byCurrency.map((e) => [e.currency, e]));

      const byCurrency = [...currencies].map((currency) => {
        const saleRow = byTypeRows.find((r: any) => r._id.type === 'sale' && (r._id.currency ?? 'USD') === currency);
        const refundRow = byTypeRows.find((r: any) => r._id.type === 'refund' && (r._id.currency ?? 'USD') === currency);
        const gmv = round(saleRow?.total ?? 0);
        const refunds = round(refundRow?.total ?? 0);
        const balances: any = balancesByCurrency.get(currency) ?? { totalAvailable: 0, totalPending: 0, totalRevenue: 0, totalFees: 0, totalRefunds: 0, totalPayouts: 0 };
        const currencyEarnings = earningsByCurrency.get(currency) ?? { commission: 0, processingFees: 0, total: 0 };

        return {
          currency,
          gmv,
          netRevenue: round(gmv - refunds),
          refunds,
          totalOrders: saleRow?.count ?? 0,
          platformEarnings: currencyEarnings.total,
          platformCommission: currencyEarnings.commission,
          paymentProcessingFees: currencyEarnings.processingFees,
          sellerBalances: {
            totalAvailable: round(balances.totalAvailable ?? 0),
            totalPending: round(balances.totalPending ?? 0),
          },
          lifetimeTotals: {
            totalRevenue: round(balances.totalRevenue ?? 0),
            totalFees: round(balances.totalFees ?? 0),
            totalRefunds: round(balances.totalRefunds ?? 0),
            totalPayouts: round(balances.totalPayouts ?? 0),
          },
        };
      }).filter((c) => c.gmv !== 0 || c.sellerBalances.totalAvailable !== 0 || c.sellerBalances.totalPending !== 0 || c.lifetimeTotals.totalRevenue !== 0);

      // Grouped by {status, currency} — a PKR payout and a USD payout in the
      // same status must never be summed into one blended "amount".
      const payoutStatuses = ['pending', 'processing', 'completed', 'failed'];
      const payoutQueue: Record<string, { count: number; amount: number; byCurrency: { currency: string; count: number; amount: number }[] }> = {};
      for (const status of payoutStatuses) {
        const rowsForStatus = payoutStatusRows.filter((r: any) => r._id.status === status);
        payoutQueue[status] = {
          count: rowsForStatus.reduce((s: number, r: any) => s + r.count, 0),
          amount: round(rowsForStatus.reduce((s: number, r: any) => s + r.amount, 0)),
          byCurrency: rowsForStatus.map((r: any) => ({ currency: r._id.currency ?? 'USD', count: r.count, amount: round(r.amount) })),
        };
      }

      // Platform-owner view: every currency rolled up into USD at the latest
      // rate. Currencies with no known rate are listed in `unconvertible`
      // and left out of the sum rather than guessed at.
      const rates = await this.getUsdRates();
      // Payout queue amounts in USD too (admin never sees a blended or native figure).
      for (const status of payoutStatuses) {
        payoutQueue[status].amount = round(payoutQueue[status].byCurrency.reduce((t, c) => t + (this.toUsd(c.amount, c.currency, rates) ?? 0), 0));
      }
      const unconvertible: string[] = [];
      const consolidatedUSD = {
        currency: 'USD',
        gmv: 0, netRevenue: 0, refunds: 0, totalOrders: 0,
        platformEarnings: 0, platformCommission: 0, paymentProcessingFees: 0,
        sellerBalances: { totalAvailable: 0, totalPending: 0 },
        pkrShare: { gmv: 0, platformEarnings: 0 },
      };
      for (const c of byCurrency) {
        const conv = (n: number) => this.toUsd(n, c.currency, rates);
        if (conv(1) === null) { unconvertible.push(c.currency); continue; }
        consolidatedUSD.gmv += conv(c.gmv)!;
        consolidatedUSD.netRevenue += conv(c.netRevenue)!;
        consolidatedUSD.refunds += conv(c.refunds)!;
        consolidatedUSD.totalOrders += c.totalOrders;
        consolidatedUSD.platformEarnings += conv(c.platformEarnings)!;
        consolidatedUSD.platformCommission += conv(c.platformCommission)!;
        consolidatedUSD.paymentProcessingFees += conv(c.paymentProcessingFees)!;
        consolidatedUSD.sellerBalances.totalAvailable += conv(c.sellerBalances.totalAvailable)!;
        consolidatedUSD.sellerBalances.totalPending += conv(c.sellerBalances.totalPending)!;
        if (c.currency !== 'USD') {
          consolidatedUSD.pkrShare.gmv += conv(c.gmv)!;
          consolidatedUSD.pkrShare.platformEarnings += conv(c.platformEarnings)!;
        }
      }
      for (const k of ['gmv', 'netRevenue', 'refunds', 'platformEarnings', 'platformCommission', 'paymentProcessingFees'] as const) {
        consolidatedUSD[k] = round(consolidatedUSD[k]);
      }
      consolidatedUSD.sellerBalances.totalAvailable = round(consolidatedUSD.sellerBalances.totalAvailable);
      consolidatedUSD.sellerBalances.totalPending = round(consolidatedUSD.sellerBalances.totalPending);
      consolidatedUSD.pkrShare = { gmv: round(consolidatedUSD.pkrShare.gmv), platformEarnings: round(consolidatedUSD.pkrShare.platformEarnings) };

      return {
        success: true,
        data: {
          period: { from, to },
          consolidatedUSD,
          fxRates: Object.fromEntries([...rates.entries()].filter(([code]) => byCurrency.some((c) => c.currency === code))),
          unconvertibleCurrencies: unconvertible,
          byCurrency,
          sellersWithBalance,
          flaggedSellersCount,
          pendingVerificationMethodsCount,
          pendingManualPaymentsCount,
          payoutQueue,
          note: 'All figures are in USD (non-USD stores converted at the latest FX rate). byCurrency keeps the native-currency rows for reference. gmv/netRevenue/refunds/totalOrders are scoped to the selected period; sellerBalances are current, all-time snapshots regardless of the date filter.',
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // B. PLATFORM REVENUE / COMMISSION TRENDS
  // ═══════════════════════════════════════════════════════════════════════

  async getRevenueOverTime(query: any) {
    const { from, to, granularity } = resolveDateRange(query);

    return this.cached(this.key('revenue-over-time-v2', { from, to, granularity }), async () => {
      // `currency` is part of the group key — a PKR seller's sale and a USD
      // seller's sale must never be added together into one grossRevenue point.
      const rows = await this.r.transactionModel.aggregate([
        { $match: { type: { $in: ['sale', 'refund'] }, status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } } },
        { $addFields: { bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } } } },
        { $group: { _id: { bucket: '$bucket', type: '$type', currency: '$currency' }, total: { $sum: { $abs: '$amount' } } } },
      ]);

      const currencies = new Set<string>((await this.adminConfigService.getEnabledCurrencies()).map((c) => c.code));
      for (const row of rows) currencies.add(row._id.currency ?? 'USD');

      const byBucket = new Map<number, Map<string, { gross: number; refunds: number }>>();
      for (const row of rows) {
        const t = row._id.bucket.getTime();
        const currency = row._id.currency ?? 'USD';
        const perCurrency = byBucket.get(t) ?? new Map<string, { gross: number; refunds: number }>();
        const entry = perCurrency.get(currency) ?? { gross: 0, refunds: 0 };
        if (row._id.type === 'sale') entry.gross = row.total; else entry.refunds = row.total;
        perCurrency.set(currency, entry);
        byBucket.set(t, perCurrency);
      }

      const rates = await this.getUsdRates();
      const series = enumerateBuckets(from, to, granularity).map((bucket) => {
        const perCurrency = byBucket.get(bucket.getTime());
        const byCurrency = [...currencies].map((currency) => {
          const e = perCurrency?.get(currency) ?? { gross: 0, refunds: 0 };
          return { currency, grossRevenue: round(e.gross), netRevenue: round(e.gross - e.refunds) };
        }).filter((c) => c.grossRevenue !== 0 || c.netRevenue !== 0);
        // USD roll-up for the platform owner (latest rate; unknown-rate currencies skipped).
        let usdGross = 0; let usdNet = 0;
        for (const c of byCurrency) {
          const g = this.toUsd(c.grossRevenue, c.currency, rates);
          const n = this.toUsd(c.netRevenue, c.currency, rates);
          if (g !== null && n !== null) { usdGross += g; usdNet += n; }
        }
        return { date: bucket, byCurrency, usd: { grossRevenue: round(usdGross), netRevenue: round(usdNet) } };
      });

      return { success: true, data: { granularity, series } };
    });
  }

  async getCommissionOverTime(query: any) {
    const { from, to, granularity } = resolveDateRange(query);

    return this.cached(this.key('commission-over-time-v2', { from, to, granularity }), async () => {
      const rows = await this.r.transactionModel.aggregate([
        { $match: { type: 'sale', status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } } },
        { $addFields: { bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } } } },
        { $group: { _id: { bucket: '$bucket', currency: '$currency' }, commission: { $sum: '$metadata.platformFee' }, processingFees: { $sum: '$metadata.processingFee' } } },
      ]);

      const currencies = new Set<string>((await this.adminConfigService.getEnabledCurrencies()).map((c) => c.code));
      for (const row of rows) currencies.add(row._id.currency ?? 'USD');

      const byBucket = new Map<number, Map<string, any>>();
      for (const row of rows) {
        const t = row._id.bucket.getTime();
        const perCurrency = byBucket.get(t) ?? new Map<string, any>();
        perCurrency.set(row._id.currency ?? 'USD', row);
        byBucket.set(t, perCurrency);
      }

      const rates = await this.getUsdRates();
      const series = enumerateBuckets(from, to, granularity).map((bucket) => {
        const perCurrency = byBucket.get(bucket.getTime());
        const byCurrency = [...currencies].map((currency) => {
          const row = perCurrency?.get(currency);
          return { currency, commission: round(row?.commission ?? 0), processingFees: round(row?.processingFees ?? 0) };
        }).filter((c) => c.commission !== 0 || c.processingFees !== 0);
        let usdCommission = 0; let usdFees = 0;
        for (const c of byCurrency) {
          const cm = this.toUsd(c.commission, c.currency, rates);
          const pf = this.toUsd(c.processingFees, c.currency, rates);
          if (cm !== null && pf !== null) { usdCommission += cm; usdFees += pf; }
        }
        return { date: bucket, byCurrency, usd: { commission: round(usdCommission), processingFees: round(usdFees) } };
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

    return this.cached(this.key('seller-balances-v2', { page, limit, sort, order, search: query.search ?? '', flaggedOnly: query.flaggedOnly ?? '' }), async () => {
      const balances = await this.r.sellerBalanceModel.find({}).lean();
      const sellerIds = [...new Set(balances.map((b: any) => b.sellerId))];
      const storeIds = balances.map((b: any) => b.storeId);

      const [sellers, stores] = await Promise.all([
        this.r.sellerModel.find({ _id: { $in: sellerIds } }).select('name email').lean(),
        this.r.storeModel.find({ _id: { $in: storeIds } }).select('name').lean(),
      ]);
      const sellerMap = new Map(sellers.map((s: any) => [s._id.toString(), s]));
      const storeMap = new Map(stores.map((s: any) => [s._id.toString(), s]));

      const rates = await this.getUsdRates();
      const usd = (n: number, c: string) => { const v = this.toUsd(n, c || 'USD', rates); return v === null ? null : round(v); };
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
        availableBalanceUSD: usd(b.availableBalance, b.currency),
        pendingBalanceUSD: usd(b.pendingBalance, b.currency),
        totalRevenueUSD: usd(b.totalRevenue, b.currency),
        totalPayoutsUSD: usd(b.totalPayouts, b.currency),
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

      // Sort by USD value - raw PKR figures are ~280x larger and would always outrank USD rows.
      rows.sort((a: any, b: any) => order * ((a[`${sort}USD`] ?? 0) - (b[`${sort}USD`] ?? 0)));

      const total = rows.length;
      const start = (page - 1) * limit;

      const totalsUSD = rows.reduce((t: any, r: any) => ({
        availableBalance: t.availableBalance + (r.availableBalanceUSD ?? 0),
        pendingBalance: t.pendingBalance + (r.pendingBalanceUSD ?? 0),
      }), { availableBalance: 0, pendingBalance: 0 });

      return {
        success: true,
        data: {
          totalsUSD: { availableBalance: round(totalsUSD.availableBalance), pendingBalance: round(totalsUSD.pendingBalance) },
          pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
          sellers: rows.slice(start, start + limit),
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // D. SELLER DRILL-DOWN — delegates to FinanceService (no ledger logic duplicated)
  // ═══════════════════════════════════════════════════════════════════════

  /** Adds `<field>USD` next to each listed field for one native-currency record (null when no FX rate exists). */
  private withUsd<T extends Record<string, any>>(row: T, currency: string | undefined, fields: string[], rates: Map<string, number>): T & Record<string, any> {
    const out: Record<string, any> = { ...row };
    for (const f of fields) {
      const v = typeof row[f] === 'number' ? this.toUsd(row[f], currency || 'USD', rates) : null;
      out[`${f}USD`] = v === null ? null : round(v);
    }
    return out as T & Record<string, any>;
  }

  /** Sums the `<field>USD` values of several balance rows into one USD summary (skips rows with no rate). */
  private sumBalancesUsd(rows: any[]) {
    const keys = ['availableBalance', 'pendingBalance', 'totalRevenue', 'totalFees', 'totalRefunds', 'totalPayouts'];
    const total: Record<string, any> = { currency: 'USD' };
    for (const k of keys) total[k] = round(rows.reduce((t, r) => t + (r[`${k}USD`] ?? 0), 0));
    return total;
  }

  async getSellerFinancialDetails(storeId: string) {
    const data: any = await this.financeService.adminGetSellerFinancialDetails(storeId);
    const rates = await this.getUsdRates();
    const storeDoc: any = await this.r.storeModel.findById(storeId).select('baseCurrency').lean();
    const baseCurrency: string | null = storeDoc?.baseCurrency ?? null;
    const balanceFields = ['availableBalance', 'pendingBalance', 'totalRevenue', 'totalFees', 'totalRefunds', 'totalPayouts'];
    const balances = (data.balances as any[]).map((b) => this.withUsd(b, b.currency, balanceFields, rates));
    return {
      success: true,
      data: {
        ...data,
        balances,
        // Single USD summary the admin UI shows - every currency the store holds, converted.
        balance: this.sumBalancesUsd(balances),
        // A manual payout debits the store's own wallet (Store.baseCurrency) - shown here in USD.
        manualPayoutAvailableUSD: round(balances.find((b) => (b.currency || 'USD') === (baseCurrency || 'USD'))?.availableBalanceUSD ?? 0),
        recentPayouts: (data.recentPayouts as any[]).map((p) => this.withUsd(p, p.currency, ['amount'], rates)),
      },
    };
  }

  private async withTransactionsUsd(data: any) {
    const rates = await this.getUsdRates();
    return { ...data, transactions: (data.transactions as any[]).map((t) => this.withUsd(t, t.currency, ['amount'], rates)) };
  }

  async getSellerTransactions(storeId: string, query: any) {
    const data = await this.financeService.adminGetSellerTransactions(storeId, query);
    return { success: true, data: await this.withTransactionsUsd(data) };
  }

  /** Cross-store rollup for the Clients workspace's Finance tab — see `FinanceService.adminGetSellerFinancialRollup`'s own comment for why this is a single indexed query, not a per-store loop. */
  async getSellerFinancialRollup(sellerId: string) {
    const data: any = await this.financeService.adminGetSellerFinancialRollup(sellerId);
    const rates = await this.getUsdRates();
    const balanceFields = ['availableBalance', 'pendingBalance', 'totalRevenue', 'totalFees', 'totalRefunds', 'totalPayouts'];
    const balances = (data.balances as any[]).map((b) => this.withUsd(b, b.currency, balanceFields, rates));
    return {
      success: true,
      data: {
        ...data,
        balances,
        totalsUSD: this.sumBalancesUsd(balances),
        recentPayouts: (data.recentPayouts as any[]).map((p) => this.withUsd(p, p.currency, ['amount'], rates)),
      },
    };
  }

  async getSellerTransactionsBySeller(sellerId: string, query: any) {
    const data = await this.financeService.adminGetSellerTransactionsBySeller(sellerId, query);
    return { success: true, data: await this.withTransactionsUsd(data) };
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
    const rates = await this.getUsdRates();
    const named = await this.attachStoreNames(data.transactions as any[]);
    const transactions = named.map((t: any) => {
      const v = this.toUsd(t.amount, t.currency || 'USD', rates);
      return { ...t, amountUSD: v === null ? null : round(v) };
    });
    return { success: true, data: { ...data, transactions } };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F. PAYOUT QUEUE & LIFECYCLE — delegates to FinanceService, enriched with store names
  // ═══════════════════════════════════════════════════════════════════════

  async getPayoutQueue(query: any) {
    const data = await this.financeService.adminGetPayoutQueue(query);
    const rates = await this.getUsdRates();
    const named = await this.attachStoreNames(data.payouts as any[]);
    const payouts = named.map((p: any) => {
      const v = this.toUsd(p.amount, p.currency || 'USD', rates);
      return { ...p, amountUSD: v === null ? null : round(v) };
    });
    // FinanceService's statusCounts sums PKR and USD amounts together -
    // recompute here per status in USD so the figure is meaningful.
    const rows = await this.r.payoutModel.aggregate([{ $group: { _id: { status: '$status', currency: '$currency' }, count: { $sum: 1 }, amount: { $sum: '$amount' } } }]);
    const statusCounts: Record<string, { count: number; amount: number }> = {};
    for (const k of Object.keys(data.statusCounts)) statusCounts[k] = { count: 0, amount: 0 };
    for (const row of rows) {
      const k = row._id.status;
      if (!statusCounts[k]) continue;
      const v = this.toUsd(row.amount, row._id.currency || 'USD', rates);
      statusCounts[k].count += row.count;
      statusCounts[k].amount = round(statusCounts[k].amount + (v ?? 0));
    }
    return { success: true, data: { ...data, payouts, statusCounts } };
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

  /** Reverses an already-completed Stripe Connect payout (fraud/dispute on the underlying sale) — see FinanceService.adminReverseStripeConnectPayout for why this is a separate action from reject (which only ever applies BEFORE money has moved). */
  async reversePayout(payoutId: string, adminId: string, reason: string) {
    const data = await this.financeService.adminReverseStripeConnectPayout(payoutId, adminId, reason);
    return { success: true, data };
  }

  async createManualPayout(storeId: string, adminId: string, amount: number, payoutMethodId: string | undefined, notes: string | undefined, ip?: string, userAgent?: string): Promise<{ success: boolean; data: any }> {
    // The admin enters USD. The payout itself must come out of the store's
    // own wallet (Store.baseCurrency, or the chosen payout method's currency),
    // so convert USD -> that currency here at the latest rate.
    const store: any = await this.r.storeModel.findById(storeId).select('baseCurrency').lean();
    let currency: string = store?.baseCurrency || 'USD';
    if (payoutMethodId) {
      const method: any = await this.r.payoutMethodModel.findOne({ _id: payoutMethodId, storeId }).select('currency').lean();
      if (method) currency = method.currency || 'USD';
    }
    const rates = await this.getUsdRates();
    const rate = rates.get(currency);
    if (!rate || rate <= 0) throw new BadRequestException(`No FX rate is set for this store's currency (${currency}) - set one in FX Settings first`);

    const nativeAmount = round(amount * rate);
    const wallet: any = await this.r.sellerBalanceModel.findOne({ storeId, currency }).select('availableBalance').lean();
    const availableUSD = round((wallet?.availableBalance ?? 0) / rate);
    if (nativeAmount > (wallet?.availableBalance ?? 0)) {
      throw new BadRequestException(`Insufficient balance - available: $${availableUSD.toFixed(2)}`);
    }

    const data = await this.financeService.adminCreateManualPayout(storeId, adminId, nativeAmount, payoutMethodId, notes, ip, userAgent, currency);
    return { success: true, data: { ...(data as any).toObject?.() ?? (data as any), amountUSD: round(amount) } };
  }

  async triggerClearingBalances() {
    const data = await this.financeService.processClearingBalances();
    const rates = await this.getUsdRates();
    const totalUSD = round(data.byCurrency.reduce((t, c) => t + (this.toUsd(c.amount, c.currency, rates) ?? 0), 0));
    return { success: true, data: { ...data, totalUSD } };
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

    return this.cached(this.key('refunds-v2', { from, to }), async () => {
      // Grouped by {storeId, currency} — a store's own settlement currency is
      // stable in practice, but reading it off the ledger row itself (rather
      // than assuming) is what lets the top-level total be broken down
      // correctly instead of summing PKR and USD refunds into one number.
      const refundRows = await this.r.transactionModel.aggregate([
        { $match: { type: 'refund', createdAt: { $gte: from, $lte: to } } },
        { $group: { _id: { storeId: '$storeId', currency: '$currency' }, totalRefunded: { $sum: { $abs: '$amount' } }, count: { $sum: 1 } } },
      ]);

      const storeIds = refundRows.map((r) => r._id.storeId);
      const stores = await this.r.storeModel.find({ _id: { $in: storeIds } }).select('name').lean();
      const storeMap = new Map(stores.map((s: any) => [s._id.toString(), s]));

      const rates = await this.getUsdRates();
      const byStore = refundRows
        .map((r) => ({
          storeId: r._id.storeId,
          storeName: storeMap.get(r._id.storeId)?.name ?? 'Unknown store',
          currency: r._id.currency ?? 'USD',
          totalRefunded: round(r.totalRefunded),
          totalRefundedUSD: (() => { const v = this.toUsd(r.totalRefunded, r._id.currency ?? 'USD', rates); return v === null ? null : round(v); })(),
          count: r.count,
        }))
        .sort((a, b) => (b.totalRefundedUSD ?? 0) - (a.totalRefundedUSD ?? 0));

      const byCurrencyMap = new Map<string, { totalRefunded: number; count: number }>();
      for (const row of byStore) {
        const entry = byCurrencyMap.get(row.currency) ?? { totalRefunded: 0, count: 0 };
        entry.totalRefunded = round(entry.totalRefunded + row.totalRefunded);
        entry.count += row.count;
        byCurrencyMap.set(row.currency, entry);
      }
      const byCurrency = [...byCurrencyMap.entries()].map(([currency, v]) => ({ currency, ...v }));

      return {
        success: true,
        data: {
          period: { from, to },
          totalRefundedUSD: round(byStore.reduce((t, r) => t + (r.totalRefundedUSD ?? 0), 0)),
          totalRefundCount: byStore.reduce((t, r) => t + r.count, 0),
          byCurrency,
          byStore,
          note: 'Platform commission is not clawed back when a refund is issued (see finance.service.ts#recordRefund — only the seller\'s balance is debited) — the platform keeps its original commission on refunded sales. This report shows refund volume only, not a commission adjustment. Headline total is in USD (non-USD stores converted at the latest rate); native-currency rows are kept in byCurrency/byStore.',
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

    return this.cached(this.key('settlement-v2', { from, to }), async () => {
      const [byTypeRows, balanceTotalsRows] = await Promise.all([
        this.r.transactionModel.aggregate([
          { $match: { status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } } },
          { $group: { _id: { type: '$type', currency: '$currency' }, total: { $sum: { $abs: '$amount' } } } },
        ]),
        this.r.sellerBalanceModel.aggregate([{ $group: { _id: '$currency', totalAvailable: { $sum: '$availableBalance' }, totalPending: { $sum: '$pendingBalance' } } }]),
      ]);

      const currencies = new Set<string>((await this.adminConfigService.getEnabledCurrencies()).map((c) => c.code));
      for (const row of byTypeRows) currencies.add(row._id.currency ?? 'USD');
      for (const row of balanceTotalsRows) currencies.add(row._id ?? 'USD');

      const balancesByCurrency = new Map(balanceTotalsRows.map((r: any) => [r._id ?? 'USD', r]));

      const byCurrency = [...currencies].map((currency) => {
        const stats: Record<string, number> = { sale: 0, fee: 0, refund: 0, payout: 0, adjustment: 0 };
        for (const row of byTypeRows) if ((row._id.currency ?? 'USD') === currency) stats[row._id.type] = round(row.total);
        const balances: any = balancesByCurrency.get(currency) ?? { totalAvailable: 0, totalPending: 0 };
        return {
          currency,
          grossSales: stats.sale,
          platformFeesCollected: stats.fee,
          refundsIssued: stats.refund,
          payoutsDisbursed: stats.payout,
          adjustments: stats.adjustment,
          outstandingObligation: {
            availableBalance: round(balances.totalAvailable ?? 0),
            pendingBalance: round(balances.totalPending ?? 0),
            totalOwedToSellers: round((balances.totalAvailable ?? 0) + (balances.totalPending ?? 0)),
          },
        };
      }).filter((c) => c.grossSales !== 0 || c.outstandingObligation.totalOwedToSellers !== 0);

      const rates = await this.getUsdRates();
      const consolidatedUSD: Record<string, number | string> = { currency: 'USD', grossSales: 0, platformFeesCollected: 0, refundsIssued: 0, payoutsDisbursed: 0, adjustments: 0, availableBalance: 0, pendingBalance: 0, totalOwedToSellers: 0 };
      const unconvertibleCurrencies: string[] = [];
      for (const c of byCurrency) {
        if (this.toUsd(1, c.currency, rates) === null) { unconvertibleCurrencies.push(c.currency); continue; }
        const add = (k: string, n: number) => { consolidatedUSD[k] = (consolidatedUSD[k] as number) + this.toUsd(n, c.currency, rates)!; };
        add('grossSales', c.grossSales);
        add('platformFeesCollected', c.platformFeesCollected);
        add('refundsIssued', c.refundsIssued);
        add('payoutsDisbursed', c.payoutsDisbursed);
        add('adjustments', c.adjustments);
        add('availableBalance', c.outstandingObligation.availableBalance);
        add('pendingBalance', c.outstandingObligation.pendingBalance);
        add('totalOwedToSellers', c.outstandingObligation.totalOwedToSellers);
      }
      for (const k of Object.keys(consolidatedUSD)) {
        if (typeof consolidatedUSD[k] === 'number') consolidatedUSD[k] = round(consolidatedUSD[k] as number);
      }

      return {
        success: true,
        data: {
          period: { from, to },
          consolidatedUSD,
          unconvertibleCurrencies,
          byCurrency,
          note: '"outstandingObligation" is a current snapshot (not scoped to the selected period) — it answers "if every seller withdrew today, how much would leave the platform", Headline figures are USD (non-USD converted at the latest rate); native-currency rows are kept per settlement currency.',
        },
      };
    });
  }

  async getMonthlyReport(query: any) {
    const months = Math.min(12, Number(query.months) || 6);
    const now = new Date();

    return this.cached(this.key('monthly-v2', { months }), async () => {
      const monthly: Array<Record<string, any>> = [];
      const rates = await this.getUsdRates();

      for (let i = months - 1; i >= 0; i--) {
        const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const to = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);

        const [byTypeRows, earnings] = await Promise.all([
          this.r.transactionModel.aggregate([
            { $match: { status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } } },
            { $group: { _id: { type: '$type', currency: '$currency' }, total: { $sum: { $abs: '$amount' } } } },
          ]),
          getPlatformEarnings(this.r.transactionModel, from, to),
        ]);

        const currencies = new Set<string>((await this.adminConfigService.getEnabledCurrencies()).map((c) => c.code));
        for (const row of byTypeRows) currencies.add(row._id.currency ?? 'USD');
        const earningsByCurrency = new Map(earnings.byCurrency.map((e) => [e.currency, e]));

        const byCurrency = [...currencies].map((currency) => {
          const stats: Record<string, number> = { sale: 0, fee: 0, refund: 0, payout: 0 };
          for (const row of byTypeRows) if ((row._id.currency ?? 'USD') === currency) stats[row._id.type] = round(row.total);
          const currencyEarnings = earningsByCurrency.get(currency) ?? { commission: 0, total: 0 };
          return {
            currency,
            gmv: stats.sale,
            refunds: stats.refund,
            payouts: stats.payout,
            platformCommission: currencyEarnings.commission,
            platformEarnings: currencyEarnings.total,
          };
        }).filter((c) => c.gmv !== 0 || c.refunds !== 0 || c.payouts !== 0 || c.platformEarnings !== 0);

        const usd = { gmv: 0, refunds: 0, payouts: 0, platformCommission: 0, platformEarnings: 0 };
        for (const c of byCurrency) {
          if (this.toUsd(1, c.currency, rates) === null) continue;
          for (const k of Object.keys(usd) as (keyof typeof usd)[]) usd[k] += this.toUsd(c[k], c.currency, rates)!;
        }
        for (const k of Object.keys(usd) as (keyof typeof usd)[]) usd[k] = round(usd[k]);

        monthly.push({
          month: from.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
          byCurrency,
          usd,
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
        const ratesForPayouts = await this.getUsdRates();
        return toCsv(
          ['Payout ID', 'Store ID', 'Amount (USD)', 'Status', 'Method', 'Requested At', 'Processed At'],
          (rows as any[]).map((p) => [
            p._id.toString(), p.storeId, (this.toUsd(p.amount, p.currency || 'USD', ratesForPayouts)?.toFixed(2) ?? ''), p.status, p.payoutMethodSnapshot?.type ?? '',
            new Date(p.createdAt).toISOString().split('T')[0],
            p.processedAt ? new Date(p.processedAt).toISOString().split('T')[0] : '',
          ]),
        );
      }
      case 'sellers': {
        const data = await this.getSellerBalances({ ...query, page: 1, limit: 5000 });
        return toCsv(
          ['Store', 'Seller', 'Email', 'Available (USD)', 'Pending (USD)', 'Total Revenue (USD)', 'Total Payouts (USD)'],
          data.data.sellers.map((s: any) => [s.storeName, s.sellerName, s.sellerEmail, s.availableBalanceUSD?.toFixed(2) ?? '', s.pendingBalanceUSD?.toFixed(2) ?? '', s.totalRevenueUSD?.toFixed(2) ?? '', s.totalPayoutsUSD?.toFixed(2) ?? '']),
        );
      }
      case 'refunds': {
        const report = await this.getRefundReport(query);
        return toCsv(
          ['Store', 'Total Refunded (USD)', 'Count'],
          report.data.byStore.map((r: any) => [r.storeName, r.totalRefundedUSD?.toFixed(2) ?? '', r.count]),
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
        const rows: [string, string][] = [];
        for (const [k, label] of [['grossSales', 'Gross Sales'], ['platformFeesCollected', 'Platform Fees Collected'], ['refundsIssued', 'Refunds Issued'], ['payoutsDisbursed', 'Payouts Disbursed'], ['availableBalance', 'Available Balance owed'], ['pendingBalance', 'Pending Balance owed']] as const) {
          rows.push([`${label} (USD total)`, Number(s.data.consolidatedUSD[k]).toFixed(2)]);
        }
        return toCsv(['Metric', 'Amount (USD)'], rows);
      }
      case 'transactions':
      default:
      {
        // Admin export is USD-only (non-USD stores converted at the latest rate).
        const filter: Record<string, any> = {};
        for (const k of ['type', 'status', 'storeId', 'sellerId', 'currency']) if (query[k]) filter[k] = query[k];
        if (query.from || query.to) {
          filter.createdAt = {};
          if (query.from) filter.createdAt.$gte = new Date(query.from);
          if (query.to) filter.createdAt.$lte = new Date(query.to);
        }
        const txs = await this.r.transactionModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
        const rates = await this.getUsdRates();
        return toCsv(
          ['Date', 'Store ID', 'Description', 'Type', 'Amount (USD)', 'Status'],
          (txs as any[]).map((t) => {
            const usd = this.toUsd(t.amount, t.currency || 'USD', rates);
            return [new Date(t.createdAt).toISOString().split('T')[0], t.storeId, t.description, t.type, usd === null ? '' : usd.toFixed(2), t.status];
          }),
        );
      }
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

    pdf.addSectionHeading('Overview (USD total)');
    const u = overview.data.consolidatedUSD;
    pdf.addKeyValueGrid([
      { label: 'GMV (USD)', value: u.gmv.toFixed(2) },
      { label: 'Net Revenue (USD)', value: u.netRevenue.toFixed(2) },
      { label: 'Platform Commission (USD)', value: u.platformCommission.toFixed(2) },
      { label: 'Total Available owed (USD)', value: u.sellerBalances.totalAvailable.toFixed(2) },
      { label: 'Total Pending owed (USD)', value: u.sellerBalances.totalPending.toFixed(2) },
    ]);
    pdf.addSectionHeading('Settlement (USD)');
    const sc = settlement.data.consolidatedUSD as any;
    pdf.addTable(['Metric', 'Amount (USD)'], [
      ['Gross Sales', Number(sc.grossSales).toFixed(2)],
      ['Platform Fees Collected', Number(sc.platformFeesCollected).toFixed(2)],
      ['Refunds Issued', Number(sc.refundsIssued).toFixed(2)],
      ['Payouts Disbursed', Number(sc.payoutsDisbursed).toFixed(2)],
    ]);

    pdf.addSectionHeading('Refunds by Store');
    if (refunds.data.byStore.length > 0) {
      pdf.addTable(
        ['Store', 'Total Refunded (USD)', 'Count'],
        refunds.data.byStore.slice(0, 20).map((r: any) => [r.storeName, r.totalRefundedUSD?.toFixed(2) ?? '', r.count]),
      );
    } else {
      pdf.addEmptyNote('No refunds recorded in this period.');
    }

    return pdf.build();
  }

  /**
   * Reconciliation: compares, per currency and over the given window, what
   * buyers were charged (Order.totalAmount) against what the ledger
   * actually recorded (sale amounts − platform fees − processing fees +
   * refunds) — the two should always agree; a real drift here means money
   * moved somewhere the ledger doesn't account for and needs investigation,
   * not a currency-conversion display quirk. Read-only; finds discrepancies,
   * never corrects them automatically.
   */
  async getReconciliation(days = 1) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [orders, saleTx, feeTx, refundTx] = await Promise.all([
      this.r.orderModel.aggregate([
        { $match: { createdAt: { $gte: since }, isDelete: false } },
        { $group: { _id: '$currency', totalCollected: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
      ]),
      this.r.transactionModel.aggregate([
        { $match: { type: 'sale', createdAt: { $gte: since } } },
        { $group: { _id: '$currency', total: { $sum: '$amount' } } },
      ]),
      this.r.transactionModel.aggregate([
        { $match: { type: 'fee', createdAt: { $gte: since } } },
        { $group: { _id: '$currency', total: { $sum: '$amount' } } }, // stored negative
      ]),
      this.r.transactionModel.aggregate([
        { $match: { type: 'refund', createdAt: { $gte: since } } },
        { $group: { _id: '$currency', total: { $sum: '$amount' } } }, // stored negative
      ]),
    ]);

    const byCurrency: Record<string, any> = {};
    const ensure = (currency: string) => {
      if (!byCurrency[currency]) {
        byCurrency[currency] = { currency, buyerCollected: 0, orderCount: 0, ledgerNet: 0, fees: 0, refunds: 0 };
      }
      return byCurrency[currency];
    };
    for (const o of orders) { const b = ensure(o._id || 'USD'); b.buyerCollected = round(o.totalCollected); b.orderCount = o.count; }
    for (const t of saleTx) { ensure(t._id || 'USD').ledgerNet += round(t.total); }
    for (const t of feeTx) { ensure(t._id || 'USD').fees += round(t.total); }
    for (const t of refundTx) { ensure(t._id || 'USD').refunds += round(t.total); }

    const TOLERANCE = 0.01; // per-currency rounding tolerance, not a real discrepancy threshold
    const results = Object.values(byCurrency).map((b: any) => {
      // ledgerNet is what sellers were actually credited net-of-fee; fees/refunds are stored as negative deltas already.
      const expectedFromLedger = round(b.ledgerNet + Math.abs(b.fees) + b.refunds);
      const drift = round(b.buyerCollected - expectedFromLedger);
      return { ...b, expectedFromLedger, drift, hasDiscrepancy: Math.abs(drift) > TOLERANCE };
    });

    return {
      success: true,
      data: {
        windowDays: days,
        byCurrency: results,
        hasAnyDiscrepancy: results.some((r) => r.hasDiscrepancy),
      },
    };
  }

  /**
   * Runs `getReconciliation`, PERSISTS the result (previously this was
   * read-only/on-demand only — nothing was ever recorded, so a discrepancy
   * that occurred between two people happening to check the dashboard would
   * go completely unnoticed), and raises an admin security alert for any
   * currency with a real discrepancy. Called by the daily scheduled job
   * (`SchedulerService#runReconciliation`, `runLocked`-protected).
   */
  async runAndPersistReconciliation(days = 1) {
    const { data } = await this.getReconciliation(days);
    const run = await this.r.reconciliationRunModel.create({
      runAt: new Date(),
      results: data.byCurrency,
      hasAnyDiscrepancy: data.hasAnyDiscrepancy,
    });

    if (data.hasAnyDiscrepancy) {
      for (const c of data.byCurrency.filter((r: any) => r.hasDiscrepancy)) {
        await this.activityLogService.log({
          storeId: 'platform',
          category: 'finance',
          action: 'reconciliation_discrepancy_detected',
          description: `Reconciliation drift of ${c.drift} ${c.currency} detected — buyer collected ${c.buyerCollected}, ledger expected ${c.expectedFromLedger}`,
          actorId: 'system',
          actorRole: 'system',
          isSecurityAlert: true,
          targetId: run._id.toString(),
          targetType: 'reconciliation_run',
        });
      }
    }

    return run;
  }

  /** Latest N persisted reconciliation runs — the admin-visible history that
   *  `getReconciliation` alone (on-demand, unpersisted) couldn't provide. */
  async getReconciliationHistory(limit = 30) {
    const runs = await this.r.reconciliationRunModel
      .find({})
      .sort({ runAt: -1 })
      .limit(Math.min(100, limit))
      .lean();
    // Admin reads drift in USD only - convert each currency's drift at the latest rate.
    const rates = await this.getUsdRates();
    const data = (runs as any[]).map((run) => {
      const results = (run.results ?? []).map((c: any) => {
        const v = this.toUsd(c.drift, c.currency || 'USD', rates);
        return { ...c, driftUSD: v === null ? null : round(v) };
      });
      return { ...run, results, totalDriftUSD: round(results.reduce((t: number, c: any) => t + (c.driftUSD ?? 0), 0)) };
    });
    return { success: true, data };
  }

  /**
   * FX exposure: the platform's net open position per currency, over
   * orders that have been collected but not yet fully settled/paid out
   * (pending clearing window, see FinanceService.CLEARING_DAYS*). Simple
   * by design — a daily snapshot, not a treasury/hedging system.
   */
  async getFxExposure() {
    const pendingSales = await this.r.transactionModel.aggregate([
      { $match: { type: 'sale', status: 'pending' } },
      { $group: { _id: '$currency', pendingAmount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);

    const rates = await this.r.exchangeRateModel.aggregate([
      { $match: { isRejected: false } },
      { $sort: { effectiveFrom: -1 } },
      { $group: { _id: '$currency', ratePerUSD: { $first: '$ratePerUSD' } } },
    ]);
    const rateByCurrency = new Map(rates.map((r: any) => [r._id, r.ratePerUSD]));

    const byCurrency = pendingSales.map((p: any) => {
      const currency = p._id || 'USD';
      const ratePerUSD = currency === 'USD' ? 1 : (rateByCurrency.get(currency) ?? null);
      const pendingUSDEquivalent = ratePerUSD ? round(p.pendingAmount / ratePerUSD) : null;
      return { currency, pendingAmount: round(p.pendingAmount), count: p.count, pendingUSDEquivalent };
    });

    const totalUSDEquivalent = round(byCurrency.reduce((s, b) => s + (b.pendingUSDEquivalent ?? 0), 0));
    const fxConfig = await this.adminConfigService.getFxConfig();
    const threshold = fxConfig?.exposureThresholdUSD ?? 50_000;

    return {
      success: true,
      data: { byCurrency, totalUSDEquivalent, threshold, breached: totalUSDEquivalent > threshold, asOf: new Date() },
    };
  }

  /**
   * Calls `getFxExposure` and raises an admin security alert if it's over
   * threshold. Called by the daily scheduled job
   * (`SchedulerService#checkFxExposure`, `runLocked`-protected) — this was
   * previously entirely absent, so a runaway open position could grow
   * indefinitely with nothing ever flagging it. Kept separate from
   * `getFxExposure` itself so the on-demand admin-dashboard read (which can
   * be called repeatedly just by viewing the page) never spams duplicate
   * alerts — only the once-a-day cron tick does. No automatic
   * hedging/trading — visibility only, matching the rest of this FX
   * system's design.
   */
  async runFxExposureCheck() {
    const { data } = await this.getFxExposure();
    if (data.breached) {
      await this.activityLogService.log({
        storeId: 'platform',
        category: 'finance',
        action: 'fx_exposure_threshold_breached',
        description: `Platform open FX exposure is $${data.totalUSDEquivalent.toFixed(2)}, above the configured $${data.threshold.toFixed(2)} threshold`,
        actorId: 'system',
        actorRole: 'system',
        isSecurityAlert: true,
      });
    }
    return data;
  }
}
