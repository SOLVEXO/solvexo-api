/* eslint-disable prettier/prettier */

const INTERNAL_ORDER_FIELDS = ['fxSnapshots', 'platformSponsoredDiscountTotal', 'attributedBannerId', 'attributedStoreBannerId', 'attributionSource', 'overdueReminderSentAt', 'checkoutId', 'isDelete', 'ratePerUSD', 'timeline', 'note'];
const INTERNAL_SELLER_ORDER_FIELDS = ['platformSponsoredDiscountUSD', 'settlementCurrency', 'settlementAmount', 'settledViaConnect', 'stripeConnectedAccountId', 'stockAlreadyDeducted'];
// Shipping-label purchase details are merchant-only (the label PDF URL must never reach a buyer).
const INTERNAL_TRACKING_FIELDS = ['labelUrl', 'labelRateId', 'labelCost', 'labelCurrency', 'labelPurchasedAt'];
const INTERNAL_ITEM_FIELDS = ['costOfGoodsSold', 'campaignSponsorType', 'campaignId', 'autoDiscountId'];

/** The buyer sees THEIR order — never the seller/platform internals the raw document carries (cost of goods,
 *  settlement/Connect/ledger fields, commission & sponsorship, FX snapshots, attribution). Returns a copy. */
/** Buyer-visible subset of a sub-order's tracking (never the label). */
export function toBuyerTracking(t: any): any {
  if (!t || typeof t !== 'object') return t ?? null;
  return { carrier: t.carrier ?? null, trackingNumber: t.trackingNumber ?? null, trackingUrl: t.trackingUrl ?? null };
}

/** Buyer-visible subset of a return label (never its cost / rate id). The buyer receives it only on their own order. */
export function toBuyerReturnLabel(l: any): any {
  if (!l || typeof l !== 'object') return null;
  return { labelUrl: l.labelUrl ?? null, trackingNumber: l.trackingNumber ?? null, trackingUrl: l.trackingUrl ?? null, carrier: l.carrier ?? null, purchasedAt: l.purchasedAt ?? null };
}

export function toBuyerSafeOrder(order: any): any {
  const safe: any = { ...order };
  for (const k of INTERNAL_ORDER_FIELDS) delete safe[k];
  safe.sellerOrders = (safe.sellerOrders ?? []).map((so: any) => {
    const out: any = { ...so };
    for (const k of INTERNAL_SELLER_ORDER_FIELDS) delete out[k];
    if (out.tracking && typeof out.tracking === 'object') {
      out.tracking = { ...out.tracking };
      for (const k of INTERNAL_TRACKING_FIELDS) delete out.tracking[k];
    }
    if (Array.isArray(out.shipments)) {
      out.shipments = out.shipments.map((sh: any) => ({ ...sh, tracking: toBuyerTracking(sh.tracking) }));
    }
    out.items = (so.items ?? []).map((it: any) => { const i: any = { ...it }; for (const k of INTERNAL_ITEM_FIELDS) delete i[k]; if (i.returnLabel) i.returnLabel = toBuyerReturnLabel(i.returnLabel); return i; });
    return out;
  });
  return safe;
}
