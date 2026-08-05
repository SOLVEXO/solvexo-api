/* eslint-disable prettier/prettier */
import { Model } from 'mongoose';
import { round } from './number.util';

/**
 * Shared "what does the platform itself earn" calculation — commission recognized
 * at sale time (`Transaction` type=sale, `metadata.platformFee` — see
 * `finance.service.ts#recordSale`) plus seller-subscription revenue
 * (`SubscriptionInvoice`, 100% platform revenue, no payout split). Used by both
 * `AdminAnalyticsService` (platform-wide analytics) and `AdminFinanceService`
 * (platform revenue/commission reporting) so this aggregation exists exactly once.
 */
export interface PlatformEarningsByCurrency {
  currency: string;
  commission: number;
  processingFees: number;
  subscriptionRevenue: number;
  total: number;
}

export interface PlatformEarnings {
  /** @deprecated blends every settlement currency into one meaningless
   *  number — kept only so existing non-currency-aware callers (e.g.
   *  AdminAnalyticsService) don't break. New callers should use
   *  `byCurrency` instead, never these blended totals. */
  commission: number;
  processingFees: number;
  subscriptionRevenue: number;
  total: number;
  byCurrency: PlatformEarningsByCurrency[];
}

export async function getPlatformEarnings(
  transactionModel: Model<any>,
  subscriptionInvoiceModel: Model<any>,
  from: Date,
  to: Date,
  scope?: { storeId?: string; sellerId?: string },
): Promise<PlatformEarnings> {
  const txMatch: Record<string, any> = { type: 'sale', status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to } };
  if (scope?.storeId) txMatch.storeId = scope.storeId;
  if (scope?.sellerId) txMatch.sellerId = scope.sellerId;

  // Subscriptions are seller-scoped, not store-scoped, in this codebase's data model — a
  // storeId-only drill-down can't be applied here without misattributing a seller's other
  // stores' subscription revenue.
  const subMatch: Record<string, any> = { status: 'paid', isDelete: false, paidAt: { $gte: from, $lte: to } };
  if (scope?.sellerId) subMatch.sellerId = scope.sellerId;

  const [commissionRows, commissionByCurrencyRows, subRows] = await Promise.all([
    transactionModel.aggregate([
      { $match: txMatch },
      { $group: { _id: null, commission: { $sum: '$metadata.platformFee' }, processingFees: { $sum: '$metadata.processingFee' } } },
    ]),
    // `Transaction.currency` is the seller's own settlement currency (see
    // FinanceService.recordSale) — grouping by it too is what makes
    // `byCurrency` below actually meaningful instead of blending a PKR
    // seller's commission and a USD seller's commission into one number.
    transactionModel.aggregate([
      { $match: txMatch },
      { $group: { _id: '$currency', commission: { $sum: '$metadata.platformFee' }, processingFees: { $sum: '$metadata.processingFee' } } },
    ]),
    subscriptionInvoiceModel.aggregate([
      { $match: subMatch },
      { $group: { _id: null, total: { $sum: '$amountUSD' } } },
    ]),
  ]);

  const commission = round(commissionRows[0]?.commission ?? 0);
  const processingFees = round(commissionRows[0]?.processingFees ?? 0);
  // SubscriptionInvoice.amountUSD is always USD — this buyer-pays-seller VIP
  // subscription system (distinct from platform billing) has no multi-currency
  // support, so it's always attributed to the USD bucket below.
  const subscriptionRevenue = round(subRows[0]?.total ?? 0);

  const byCurrency: PlatformEarningsByCurrency[] = commissionByCurrencyRows.map((row: any) => ({
    currency: row._id ?? 'USD',
    commission: round(row.commission ?? 0),
    processingFees: round(row.processingFees ?? 0),
    subscriptionRevenue: 0,
    total: round(row.commission ?? 0),
  }));
  const usdEntry = byCurrency.find((e) => e.currency === 'USD');
  if (usdEntry) {
    usdEntry.subscriptionRevenue = subscriptionRevenue;
    usdEntry.total = round(usdEntry.total + subscriptionRevenue);
  } else if (subscriptionRevenue > 0) {
    byCurrency.push({ currency: 'USD', commission: 0, processingFees: 0, subscriptionRevenue, total: subscriptionRevenue });
  }

  return {
    commission, processingFees, subscriptionRevenue,
    total: round(commission + subscriptionRevenue),
    byCurrency,
  };
}
