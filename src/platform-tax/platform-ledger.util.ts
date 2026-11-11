/* eslint-disable prettier/prettier */
// Pure builders: one source document in, one ledger row out. No database, no network, no tax authority.
// RULE: a source that never stored its tax is `taxKnown:false` with null tax fields. It is never 0.
import type { LedgerSourceType } from '../tax-core/legal-invoice.types';
import type { TaxLine } from '../tax-core/tax-line.types';

export interface LedgerFacts {
  sourceType: LedgerSourceType;
  sourceId: string;
  storeId: string;
  sellerId: string | null;
  paidAt: Date;
  taxKnown: boolean;
  netUSD: number | null;
  chargedTaxUSD: number | null;
  totalUSD: number | null;
  taxLines: TaxLine[] | null;
  refundedUSD: number;
  status: string;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const validDate = (v: unknown): Date | null => { const d = v ? new Date(v as any) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };

/** A paid platform-plan invoice. `subtotalUSD` is null on invoices from before tax was recorded, so those are UNKNOWN (`taxAmountUSD` defaults to 0 and proves nothing). */
export function planInvoiceFacts(inv: any): LedgerFacts | null {
  const paidAt = validDate(inv?.paidAt);
  if (!paidAt || !['paid', 'refunded', 'partially_refunded'].includes(String(inv.status))) return null;
  const total = num(inv.amountUSD) ? inv.amountUSD : null;
  const known = num(inv.subtotalUSD);
  const tax = known ? (num(inv.taxAmountUSD) ? inv.taxAmountUSD : 0) : null;
  return {
    sourceType: 'plan_invoice', sourceId: String(inv._id), storeId: String(inv.storeId), sellerId: inv.sellerId ? String(inv.sellerId) : null, paidAt,
    taxKnown: known, netUSD: known ? inv.subtotalUSD : null, chargedTaxUSD: tax, totalUSD: total,
    taxLines: known ? (tax! > 0 ? [{ label: inv.taxLabel ?? null, ratePercent: num(inv.taxRatePercent) && inv.taxRatePercent > 0 ? inv.taxRatePercent : null, amountUSD: tax!, country: inv.taxCountry ?? null }] : []) : null,
    refundedUSD: num(inv.refundedAmountUSD) ? inv.refundedAmountUSD : 0, status: String(inv.status),
  };
}

/** Every charge of an add-on purchase (a monthly add-on has one per month). `taxUSD` missing on a charge = unknown (read the raw document: Mongoose would fill the default 0). */
export function addonChargeFacts(purchase: any): LedgerFacts[] {
  const out: LedgerFacts[] = [];
  (purchase?.charges ?? []).forEach((c: any, i: number) => {
    const paidAt = validDate(c?.chargedAt);
    if (!paidAt || !num(c.amountUSD)) return;
    const known = num(c.taxUSD);
    out.push({
      sourceType: 'addon_charge', sourceId: `${String(purchase._id)}:${i}`, storeId: String(purchase.storeId), sellerId: purchase.sellerId ? String(purchase.sellerId) : null, paidAt,
      taxKnown: known, netUSD: c.amountUSD, chargedTaxUSD: known ? c.taxUSD : null, totalUSD: known ? r2(c.amountUSD + c.taxUSD) : null,
      taxLines: known ? (c.taxUSD > 0 ? [{ label: null, ratePercent: null, amountUSD: c.taxUSD, country: null }] : []) : null,
      refundedUSD: 0, status: 'paid',
    });
  });
  return out;
}

/** A PAID monthly transaction-fee bill. Bills from before the tax field existed have no `taxAmountUSD` in the stored document: unknown. */
export function feeBillFacts(bill: any): LedgerFacts | null {
  const paidAt = validDate(bill?.paidAt);
  if (!paidAt || bill.status !== 'paid' || !num(bill.amountUSD)) return null;
  const known = num(bill.taxAmountUSD);
  return {
    sourceType: 'fee_bill', sourceId: String(bill._id), storeId: String(bill.storeId), sellerId: bill.sellerId ? String(bill.sellerId) : null, paidAt,
    taxKnown: known, netUSD: bill.amountUSD, chargedTaxUSD: known ? bill.taxAmountUSD : null, totalUSD: known ? r2(bill.amountUSD + bill.taxAmountUSD) : null,
    taxLines: known ? (bill.taxAmountUSD > 0 ? [{ label: null, ratePercent: null, amountUSD: bill.taxAmountUSD, country: null }] : []) : null,
    refundedUSD: 0, status: 'paid',
  };
}

const RECORD_SOURCE: Record<string, LedgerSourceType> = { pos_plan: 'pos_plan', promotion: 'promotion', store_app: 'store_app' };

/**
 * One-off charges (POS plan, promotion, store-app fee) exist in the tax record ONLY when tax was collected, and the record has no net or
 * total. So the tax is known, the net is not. A one-off charge that carried no tax has no record and therefore no ledger row (a known gap).
 */
export function taxRecordFacts(rec: any): LedgerFacts | null {
  const sourceType = RECORD_SOURCE[String(rec?.source)];
  const paidAt = validDate(rec?.collectedAt);
  if (!sourceType || !paidAt || !num(rec.taxAmountUSD) || !rec.refId) return null;
  return {
    sourceType, sourceId: String(rec.refId), storeId: String(rec.storeId), sellerId: null, paidAt,
    taxKnown: true, netUSD: null, chargedTaxUSD: rec.taxAmountUSD, totalUSD: null,
    taxLines: [{ label: null, ratePercent: null, amountUSD: rec.taxAmountUSD, country: null }],
    refundedUSD: 0, status: 'paid',
  };
}
