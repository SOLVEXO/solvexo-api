/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { saleSubtotalExpr, sumUSD } from '../analytics/utils/order-aggregation.util';
import { latestUsdRates, toUsd } from '../common/usd-rates.util';
import {
  type MonthRow, type RevenueStream, type StoreRow, REVENUE_STREAMS, buildMonths, concentration, monthKeys, summarizeStreams,
} from './revenue-model.util';

const CACHE_MS = 10 * 60_000;
const month = (field: string) => ({ $dateToString: { format: '%Y-%m', date: field } });

/**
 * Solvexo revenue by stream and month, merchant GMV, take rate and revenue concentration (see revenue-model.util.ts).
 * Uses the same rules as Finance → Solvexo revenue (plan invoices net of tax and refunds, add-on charges, collected
 * transaction-fee bills) plus commission on platform-held sales (as on the Analytics overview), POS plan purchases
 * and paid promotions. Store-app build fees aren't stored per request, so they're left out and the response says so.
 */
@Injectable()
export class RevenueModelService {
  private cache = new Map<number, { at: number; value: any }>();

  constructor(private readonly db: DatabaseService) {}

  private get r() { return this.db.repositories; }

  async getRevenueModel(monthsWanted = 12, now = Date.now()) {
    const months = Math.min(Math.max(Math.trunc(monthsWanted) || 12, 3), 24);
    const hit = this.cache.get(months);
    if (hit && now - hit.at < CACHE_MS) return hit.value;
    const value = await this.compute(months, now);
    this.cache.set(months, { at: now, value });
    return value;
  }

  private async compute(months: number, now: number) {
    const keys = monthKeys(months, now);
    const d = new Date(now);
    const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (months - 1), 1));
    const to = new Date(now);
    const r = this.r;

    const [plans, fees, addons, commission, pos, promos, gmv, rates] = await Promise.all([
      r.platformPlanInvoiceModel.aggregate([
        { $match: { status: { $in: ['paid', 'partially_refunded', 'refunded'] }, isDelete: false, paidAt: { $gte: from, $lte: to } } },
        // Same as Finance: Solvexo's own tax isn't revenue, and a refund splits between net and tax like the charge did.
        { $addFields: { _tax: { $ifNull: ['$taxAmountUSD', 0] } } },
        { $addFields: { _taxShare: { $cond: [{ $gt: ['$amountUSD', 0] }, { $divide: ['$_tax', '$amountUSD'] }, 0] } } },
        { $group: { _id: { m: month('$paidAt'), s: '$storeId' }, amount: { $sum: { $subtract: [{ $subtract: ['$amountUSD', '$_tax'] }, { $multiply: [{ $ifNull: ['$refundedAmountUSD', 0] }, { $subtract: [1, '$_taxShare'] }] }] } } } },
      ]),
      r.transactionFeeBillModel.aggregate([
        { $match: { status: 'paid', isDelete: false, paidAt: { $gte: from, $lte: to } } },
        { $group: { _id: { m: month('$paidAt'), s: '$storeId' }, amount: { $sum: '$amountUSD' } } },
      ]),
      r.platformAddonPurchaseModel.aggregate([
        { $addFields: { _charges: { $cond: [{ $gt: [{ $size: { $ifNull: ['$charges', []] } }, 0] }, '$charges', [{ amountUSD: '$priceUSD', chargedAt: '$createdAt' }]] } } },
        { $unwind: '$_charges' },
        { $match: { '_charges.chargedAt': { $gte: from, $lte: to } } },
        { $group: { _id: { m: month('$_charges.chargedAt'), s: '$storeId' }, amount: { $sum: '$_charges.amountUSD' } } },
      ]),
      // Commission netted out of platform-held sales; direct-settled sales are billed as transaction fees instead.
      r.transactionModel.aggregate([
        { $match: { type: 'sale', status: { $ne: 'failed' }, 'metadata.settledDirectly': { $ne: true }, createdAt: { $gte: from, $lte: to } } },
        { $group: { _id: { m: month('$createdAt'), s: '$storeId', c: '$currency' }, amount: { $sum: { $ifNull: ['$metadata.platformFee', 0] } } } },
      ]),
      r.posPurchaseModel.aggregate([
        { $match: { purchasedAt: { $gte: from, $lte: to } } },
        { $group: { _id: { m: month('$purchasedAt'), s: '$storeId', c: '$currencySnapshot' }, amount: { $sum: '$priceSnapshot' } } },
      ]),
      r.promotionRequestModel.aggregate([
        { $match: { paymentStatus: 'paid', createdAt: { $gte: from, $lte: to } } },
        { $group: { _id: { m: month('$createdAt'), s: '$storeId' }, amount: { $sum: '$priceUSD' } } },
      ]),
      // GMV exactly as Analytics computes it: non-cancelled seller orders, item subtotal, converted to USD per order.
      r.orderModel.aggregate([
        { $match: { isDelete: false, createdAt: { $gte: from, $lte: to } } },
        { $unwind: '$sellerOrders' },
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
        { $group: { _id: month('$createdAt'), gmv: sumUSD(saleSubtotalExpr()), orders: { $sum: 1 } } },
      ]),
      latestUsdRates(r.exchangeRateModel),
    ]);

    const unconverted = new Set<string>();
    const usdRows = (rows: any[], converted: boolean) => rows.flatMap((x) => {
      const amount = converted ? toUsd(x.amount ?? 0, x._id.c ?? 'USD', rates) : (x.amount ?? 0);
      if (amount === null) { unconverted.add(String(x._id.c)); return []; }
      return [{ month: x._id.m as string, storeId: x._id.s ? String(x._id.s) : '', amount }];
    });
    const streamRows: Record<RevenueStream, (MonthRow & StoreRow)[]> = {
      plans: usdRows(plans, false), transactionFees: usdRows(fees, false), commission: usdRows(commission, true),
      addons: usdRows(addons, false), posPlans: usdRows(pos, true), promotions: usdRows(promos, false),
    };

    const monthly = buildMonths(keys, streamRows, gmv.map((g: any) => ({ month: g._id, gmv: g.gmv ?? 0, orders: g.orders ?? 0 })));
    const conc = concentration(REVENUE_STREAMS.flatMap((k) => streamRows[k]));
    const stores: any[] = conc.top.length
      ? await r.storeModel.find({ _id: { $in: conc.top.map((t) => t.storeId) } }).select('name sellerId').lean() : [];
    const storeMap = new Map(stores.map((s) => [String(s._id), s]));

    const sum = (f: (m: (typeof monthly)[number]) => number) => Math.round(monthly.reduce((s, m) => s + f(m), 0) * 100) / 100;
    const totalRevenue = sum((m) => m.total), totalGmv = sum((m) => m.gmv), totalTransactional = sum((m) => m.transactional);
    const pct = (n: number, dd: number) => (dd > 0 ? Math.round((n / dd) * 10000) / 100 : null);
    const lastFull = monthly[monthly.length - 2];

    return {
      success: true,
      data: {
        months, from: from.toISOString(),
        summary: {
          totalRevenue, totalGmv, takeRatePercent: pct(totalRevenue, totalGmv), transactionalTakeRatePercent: pct(totalTransactional, totalGmv),
          subscriptionSharePercent: pct(totalRevenue - totalTransactional, totalRevenue),
          thisMonthSoFar: monthly[monthly.length - 1].total,
          lastFullMonth: lastFull ? { month: lastFull.month, revenue: lastFull.total, takeRatePercent: lastFull.takeRatePercent } : null,
          revenuePerPayingStore: conc.payingStores ? Math.round((totalRevenue / conc.payingStores) * 100) / 100 : null,
          payingStores: conc.payingStores,
        },
        monthly,
        streams: summarizeStreams(monthly),
        concentration: {
          top10SharePercent: conc.top10SharePercent,
          top: conc.top.map((t) => ({ ...t, storeName: storeMap.get(t.storeId)?.name ?? 'Unknown store', sellerId: storeMap.get(t.storeId)?.sellerId ? String(storeMap.get(t.storeId).sellerId) : null })),
        },
        notes: {
          excluded: ['Store-app build fees (the fee charged isn\'t stored per request)'],
          ...(unconverted.size ? { unconvertedCurrencies: [...unconverted] } : {}),
        },
      },
    };
  }
}
