/* eslint-disable prettier/prettier */

const INTERNAL_ORDER_FIELDS = ['fxSnapshots', 'platformSponsoredDiscountTotal', 'attributedBannerId', 'attributedStoreBannerId', 'attributionSource', 'overdueReminderSentAt', 'checkoutId', 'isDelete', 'ratePerUSD', 'timeline', 'note'];
const INTERNAL_SELLER_ORDER_FIELDS = ['platformSponsoredDiscountUSD', 'settlementCurrency', 'settlementAmount', 'settledViaConnect', 'stripeConnectedAccountId', 'stockAlreadyDeducted'];
const INTERNAL_ITEM_FIELDS = ['costOfGoodsSold', 'campaignSponsorType', 'campaignId', 'autoDiscountId'];

/** The buyer sees THEIR order — never the seller/platform internals the raw document carries (cost of goods,
 *  settlement/Connect/ledger fields, commission & sponsorship, FX snapshots, attribution). Returns a copy. */
export function toBuyerSafeOrder(order: any): any {
  const safe: any = { ...order };
  for (const k of INTERNAL_ORDER_FIELDS) delete safe[k];
  safe.sellerOrders = (safe.sellerOrders ?? []).map((so: any) => {
    const out: any = { ...so };
    for (const k of INTERNAL_SELLER_ORDER_FIELDS) delete out[k];
    out.items = (so.items ?? []).map((it: any) => { const i: any = { ...it }; for (const k of INTERNAL_ITEM_FIELDS) delete i[k]; return i; });
    return out;
  });
  return safe;
}
