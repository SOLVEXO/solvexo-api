/* eslint-disable prettier/prettier */
import { checkMinorPairs, isoExponent, MinorMismatch, toMinor } from './money-minor.util';

/**
 * G3.0 money twins for the supply side (purchase orders, supplier returns, lot costs, variant costs) — exactly the G1b recipe:
 * every cost the code writes as a decimal is ALSO written as an integer `...Minor` twin from the SAME value (dual-write), a checker proves the
 * pair after the write (it logs and counts; it never rejects the write), reads keep using the decimals until a separate approval flips them.
 * The exponent is always the ISO-4217 one of the document's / store's currency, never the storefront display decimals.
 *
 * Note on unit costs: a weighted-average cost can have more decimals than the currency has minor units (12.3456 in a 2-decimal currency).
 * The twin is the value on the currency's grid (what every total uses); the sub-minor remainder stays in the decimal and is reported by the backfill as "off grid".
 */
export const COST_MINOR_PAIRS = {
  purchaseOrder: [['subtotal', 'subtotalMinor'], ['shippingCost', 'shippingCostMinor'], ['taxCost', 'taxCostMinor'], ['total', 'totalMinor'], ['items[].unitCost', 'items[].unitCostMinor']],
  supplierReturn: [['totalCredit', 'totalCreditMinor'], ['items[].unitCost', 'items[].unitCostMinor']],
  stockLot: [['costPrice', 'costPriceMinor']],
  variant: [['costPrice', 'costPriceMinor']],
} as const satisfies Record<string, ReadonlyArray<readonly [string, string]>>;
export type CostMinorKind = keyof typeof COST_MINOR_PAIRS;

/** Decimal → minor twin (null stays null: "no cost recorded" is not a zero cost). */
export const costTwin = (v: number | null | undefined, exp: number): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : toMinor(Number(v), exp));

export const expOf = (currency: string | null | undefined): number => isoExponent(currency);

/** The twins of a purchase order (and its lines), computed from its own decimals and its own currency. Used by the schema hook and the backfill. */
export function purchaseOrderTwins(po: { currency?: string | null; items?: Array<{ unitCost?: number }>; subtotal?: number; shippingCost?: number; taxCost?: number; total?: number }) {
  const exp = expOf(po.currency);
  return {
    exp,
    subtotalMinor: toMinor(po.subtotal ?? 0, exp), shippingCostMinor: toMinor(po.shippingCost ?? 0, exp), taxCostMinor: toMinor(po.taxCost ?? 0, exp), totalMinor: toMinor(po.total ?? 0, exp),
    itemUnitCostMinor: (po.items ?? []).map((i) => toMinor(i.unitCost ?? 0, exp)),
  };
}

/** Pure check: returns the pairs whose minor twin disagrees with its decimal (a missing pair on a legacy row is not a mismatch). */
export function checkCostMinor(kind: CostMinorKind, doc: any, exp: number): MinorMismatch[] {
  if (!doc) return [];
  const plain = typeof doc.toObject === 'function' ? doc.toObject({ getters: true, virtuals: false }) : doc;
  return checkMinorPairs(plain, COST_MINOR_PAIRS[kind] as unknown as Array<[string, string]>, exp);
}

/** Runs the checker after a write: logs + counts, NEVER throws (a checker bug must not stop a stock receipt). */
export const costMinorMetrics: Record<string, { checked: number; mismatched: number }> = {};
export function recordCostMinor(kind: CostMinorKind, doc: any, exp: number): MinorMismatch[] {
  try {
    const mm = checkCostMinor(kind, doc, exp);
    const m = (costMinorMetrics[kind] ??= { checked: 0, mismatched: 0 });
    m.checked++;
    if (mm.length) {
      m.mismatched++;
      // eslint-disable-next-line no-console
      console.error(`[cost-minor-mismatch] ${kind} ${String(doc?._id)}: ${JSON.stringify(mm.slice(0, 5))}`);
    }
    return mm;
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error('[cost-minor-check] checker failed (ignored):', e?.message);
    return [];
  }
}
