/* eslint-disable prettier/prettier */
import { Model } from 'mongoose';
import { round } from './number.util';

/**
 * Shared "what does the platform itself earn" calculation — commission recognized
 * at sale time (`Transaction` type=sale, `metadata.platformFee` — see
 * `finance.service.ts#recordSale`). (Buyer VIP/membership-plan revenue was removed
 * together with that feature.) Used by both
 * `AdminAnalyticsService` (platform-wide analytics) and `AdminFinanceService`
 * (platform revenue/commission reporting) so this aggregation exists exactly once.
 */
export interface PlatformEarningsByCurrency {
  currency: string;
  commission: number;
  processingFees: number;
  total: number;
}

export interface PlatformEarnings {
  /** @deprecated blends every settlement currency into one meaningless
   *  number. AdminAnalyticsService (Owner Analytics) migrated off this in
   *  Phase 2 — see its own `earningsInUSD` helper, which extracts the USD
   *  entry from `byCurrency` and discloses any other currency separately.
   *  Kept only so AdminFinanceService (not yet migrated) doesn't break.
   *  Any new caller should use `byCurrency` instead, never these blended
   *  totals. */
  commission: number;
  processingFees: number;
  total: number;
  byCurrency: PlatformEarningsByCurrency[];
}

export async function getPlatformEarnings(
  transactionModel: Model<any>,
  from: Date,
  to: Date,
  scope?: { storeId?: string; sellerId?: string },
): Promise<PlatformEarnings> {
  // Commission netted out of platform-held sales only. A direct-settled sale (COD / bank transfer /
  // the seller's own gateway — `metadata.settledDirectly`) never moved money through the platform:
  // its fee is invoiced on the seller's monthly bill and reported as "transaction fees" from
  // TransactionFeeBill (see AdminFinanceService#getPlatformRevenue), so counting it here would
  // double-count it AND recognize revenue that may never be collected.
  const txMatch: Record<string, any> = {
    type: 'sale', status: { $ne: 'failed' }, createdAt: { $gte: from, $lte: to },
    'metadata.settledDirectly': { $ne: true },
  };
  if (scope?.storeId) txMatch.storeId = scope.storeId;
  if (scope?.sellerId) txMatch.sellerId = scope.sellerId;

  const [commissionRows, commissionByCurrencyRows] = await Promise.all([
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
  ]);

  const commission = round(commissionRows[0]?.commission ?? 0);
  const processingFees = round(commissionRows[0]?.processingFees ?? 0);
  const byCurrency: PlatformEarningsByCurrency[] = commissionByCurrencyRows.map((row: any) => ({
    currency: row._id ?? 'USD',
    commission: round(row.commission ?? 0),
    processingFees: round(row.processingFees ?? 0),
    total: round(row.commission ?? 0),
  }));

  return {
    commission, processingFees,
    total: commission,
    byCurrency,
  };
}
