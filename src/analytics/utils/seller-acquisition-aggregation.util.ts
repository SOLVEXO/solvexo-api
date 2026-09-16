/* eslint-disable prettier/prettier */
// Phase 9 — Merchant Acquisition Tracking.
//
// Deliberately SEPARATE from Order.attributionSource: that field is
// buyer-side, self-reported at checkout time, and answers "what made THIS
// BUYER complete THIS PURCHASE." This util answers a different question —
// "how did THIS SELLER find the platform and sign up" — sourced from a
// UTM/referrer snapshot captured client-side (see
// src/utils/sellerAcquisitionAttribution.ts in the frontend) and stored
// once, immutably, on the Seller document at signup (see
// Seller.acquisitionSource/acquisitionMedium/acquisitionCampaign/
// acquisitionCapturedAt). Never derived from, blended with, or fall back
// onto attributionSource.

export const UNATTRIBUTED_LABEL = 'Organic / Direct';

export interface SellerAcquisitionRow {
  source: string;
  medium: string | null;
  campaign: string | null;
  sellerCount: number;
}

export interface SellerAcquisitionLean {
  acquisitionSource?: string | null;
  acquisitionMedium?: string | null;
  acquisitionCampaign?: string | null;
  acquisitionCapturedAt?: Date | string | null;
}

/**
 * Groups already-fetched sellers by acquisition source/medium/campaign.
 * Pure/testable — the caller runs the real Mongo query
 * (sellerModel.find(...).select(...).lean()); this only buckets the
 * results in memory (seller volume is nowhere near order volume, so an
 * in-memory group-by is fine here — same reasoning already applied to
 * getSellerPerformance/getProductPerformance elsewhere in this service).
 *
 * A seller with no captured value at all (acquisitionSource missing/blank)
 * is bucketed as UNATTRIBUTED_LABEL. That bucket is NOT purely "verified
 * organic traffic" — it also silently absorbs every seller who signed up
 * BEFORE this tracking existed (their acquisitionCapturedAt is null too,
 * indistinguishable at the data level from a genuine no-UTM/no-referrer
 * visit). Callers MUST disclose this via a `note`, never present the
 * bucket as a clean organic-traffic measurement.
 */
export function aggregateSellerAcquisition(sellers: SellerAcquisitionLean[]): SellerAcquisitionRow[] {
  const buckets = new Map<string, SellerAcquisitionRow>();

  for (const s of sellers) {
    const source = s.acquisitionSource?.trim() || UNATTRIBUTED_LABEL;
    const medium = s.acquisitionMedium?.trim() || null;
    const campaign = s.acquisitionCampaign?.trim() || null;
    const key = `${source}::${medium ?? ''}::${campaign ?? ''}`;

    const existing = buckets.get(key);
    if (existing) {
      existing.sellerCount += 1;
    } else {
      buckets.set(key, { source, medium, campaign, sellerCount: 1 });
    }
  }

  return Array.from(buckets.values()).sort((a, b) => b.sellerCount - a.sellerCount);
}
