/* eslint-disable prettier/prettier */
import { Model } from 'mongoose';

/** Latest accepted rate per currency (units per 1 USD), with USD = 1. */
export async function latestUsdRates(exchangeRateModel: Model<any>): Promise<Map<string, number>> {
  const rates = await exchangeRateModel.aggregate([
    { $match: { isRejected: false } },
    { $sort: { effectiveFrom: -1 } },
    { $group: { _id: '$currency', ratePerUSD: { $first: '$ratePerUSD' } } },
  ]);
  const map = new Map<string, number>(rates.map((r: any) => [r._id, r.ratePerUSD]));
  map.set('USD', 1);
  return map;
}

/** USD value of an amount, or null when the currency has no known rate (callers disclose it instead of guessing). */
export function toUsd(amount: number, currency: string, rates: Map<string, number>): number | null {
  const rate = rates.get(String(currency ?? 'USD').toUpperCase()) ?? rates.get(currency);
  return rate && rate > 0 ? amount / rate : null;
}
