/* eslint-disable prettier/prettier */
/**
 * Pure B2B rules (Shopify B2B parity, seller-owned wholesale): catalog price resolution, volume pricing, quantity rules,
 * payment terms and installment balances. No database access here: services load the data and call these, and the server
 * (never the client) recomputes every price and rule with them at cart and checkout. Money is in the STORE currency.
 */

export const MAX_PRICE_BREAKS = 10;
export const PAYMENT_TERM_TYPES = ['due_on_order', 'net', 'due_on_fulfilment'] as const;
export type PaymentTermType = (typeof PAYMENT_TERM_TYPES)[number];
export const NET_DAYS = [15, 30, 60] as const;

export interface PriceBreak { minQty: number; price: number }

export interface CatalogEntry {
  available: boolean;
  /** Fixed wholesale price for the variant. Wins over any percentage adjustment. */
  fixedPrice?: number | null;
  /** +/- percent on the base price (negative = cheaper). Used when there is no fixed price. */
  adjustmentPercent?: number | null;
  minQty?: number | null;
  maxQty?: number | null;
  increment?: number | null;
  priceBreaks?: PriceBreak[] | null;
}

export interface QuantityRule { min: number; max: number | null; increment: number }
export interface PaymentTerms { type: PaymentTermType; netDays?: number | null }
export interface InstallmentPayment { amount: number; voided?: boolean }

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Unit price for `qty` units. Precedence (highest first):
 *  1. the volume price break with the largest minQty <= qty
 *  2. the entry's fixed price
 *  3. the entry's percentage adjustment
 *  4. the catalog's default percentage adjustment
 *  5. the base (retail) price
 * A volume break is the price itself, not an extra discount, so it replaces the fixed/percentage price.
 */
export function resolveCatalogPrice(
  basePrice: number,
  entry: CatalogEntry | null | undefined,
  qty: number,
  catalogDefaultAdjustmentPercent?: number | null,
): number {
  const base = Math.max(0, Number(basePrice) || 0);
  if (!entry) return pctAdjust(base, catalogDefaultAdjustmentPercent);
  const breaks = [...(entry.priceBreaks ?? [])].sort((a, b) => a.minQty - b.minQty);
  let hit: PriceBreak | null = null;
  for (const b of breaks) if (qty >= b.minQty) hit = b;
  if (hit) return round2(Math.max(0, hit.price));
  if (typeof entry.fixedPrice === 'number' && entry.fixedPrice >= 0) return round2(entry.fixedPrice);
  if (typeof entry.adjustmentPercent === 'number') return pctAdjust(base, entry.adjustmentPercent);
  return pctAdjust(base, catalogDefaultAdjustmentPercent);
}

function pctAdjust(base: number, percent?: number | null): number {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return round2(base);
  return round2(Math.max(0, base * (1 + percent / 100)));
}

/** Seller input check for a variant's price breaks: at most 10, whole-number quantities >= 2, strictly ascending, never rising in price. */
export function validatePriceBreaks(breaks: PriceBreak[] | null | undefined): string | null {
  if (!breaks || breaks.length === 0) return null;
  if (breaks.length > MAX_PRICE_BREAKS) return `At most ${MAX_PRICE_BREAKS} price breaks per variant`;
  let prevQty = 1;
  let prevPrice = Infinity;
  for (const b of breaks) {
    if (!Number.isInteger(b.minQty) || b.minQty < 2) return 'A price break quantity must be a whole number of 2 or more';
    if (b.minQty <= prevQty) return 'Price break quantities must be unique and increasing';
    if (typeof b.price !== 'number' || !Number.isFinite(b.price) || b.price < 0) return 'A price break price must be 0 or more';
    if (b.price > prevPrice) return 'A larger quantity cannot cost more per unit than a smaller one';
    prevQty = b.minQty;
    prevPrice = b.price;
  }
  return null;
}

/** Effective rule: catalog entry first, then the product's own order quantity fields, then 1 / unlimited / 1. */
export function effectiveQuantityRule(
  entry: CatalogEntry | null | undefined,
  product?: { orderMinQuantity?: number | null; orderMaxQuantity?: number | null; orderQuantityStep?: number | null } | null,
): QuantityRule {
  const pick = (a?: number | null, b?: number | null) => (typeof a === 'number' && a > 0 ? a : typeof b === 'number' && b > 0 ? b : null);
  const increment = pick(entry?.increment, product?.orderQuantityStep) ?? 1;
  const min = pick(entry?.minQty, product?.orderMinQuantity) ?? 1;
  const max = pick(entry?.maxQty, product?.orderMaxQuantity);
  return { min, max, increment };
}

/** Seller input check for a rule definition (Shopify: min and max must be multiples of the increment, min <= max). */
export function validateQuantityRuleDefinition(rule: { minQty?: number | null; maxQty?: number | null; increment?: number | null }): string | null {
  const { minQty, maxQty, increment } = rule;
  for (const [k, v] of Object.entries({ minQty, maxQty, increment })) {
    if (v != null && (!Number.isInteger(v) || v < 1)) return `${k} must be a whole number of 1 or more`;
  }
  const inc = increment ?? 1;
  if (minQty != null && minQty % inc !== 0) return 'Minimum must be a multiple of the increment';
  if (maxQty != null && maxQty % inc !== 0) return 'Maximum must be a multiple of the increment';
  if (minQty != null && maxQty != null && minQty > maxQty) return 'Minimum cannot be above the maximum';
  return null;
}

export type QuantityCheck = { ok: true } | { ok: false; reason: string; suggested: number };

export function checkQuantity(qty: number, rule: QuantityRule): QuantityCheck {
  const nearest = (): number => {
    const stepped = Math.max(rule.min, Math.round(qty / rule.increment) * rule.increment || rule.min);
    const capped = rule.max != null ? Math.min(stepped, rule.max) : stepped;
    return capped;
  };
  if (!Number.isInteger(qty) || qty < 1) return { ok: false, reason: 'Quantity must be a whole number of 1 or more', suggested: rule.min };
  if (qty < rule.min) return { ok: false, reason: `Minimum order quantity is ${rule.min}`, suggested: rule.min };
  if (rule.max != null && qty > rule.max) return { ok: false, reason: `Maximum order quantity is ${rule.max}`, suggested: rule.max };
  if (qty % rule.increment !== 0) return { ok: false, reason: `Quantity must be a multiple of ${rule.increment}`, suggested: nearest() };
  return { ok: true };
}

export function validatePaymentTerms(terms: PaymentTerms | null | undefined): string | null {
  if (!terms) return null;
  if (!PAYMENT_TERM_TYPES.includes(terms.type)) return 'Unknown payment terms type';
  if (terms.type === 'net' && !NET_DAYS.includes(terms.netDays as any)) return `Net terms must be ${NET_DAYS.join(', ')} days`;
  return null;
}

/**
 * Due date of an order's balance. due_on_order = the day it is placed; net = placed + N days;
 * due_on_fulfilment = the fulfilment day (null until the order is fulfilled).
 */
export function paymentDueDate(terms: PaymentTerms | null | undefined, placedAt: Date, fulfilledAt?: Date | null): Date | null {
  if (!terms || terms.type === 'due_on_order') return new Date(placedAt);
  if (terms.type === 'net') return new Date(placedAt.getTime() + (terms.netDays ?? 30) * 86_400_000);
  return fulfilledAt ? new Date(fulfilledAt) : null;
}

export const isOverdue = (due: Date | null, outstanding: number, now = new Date()) => !!due && outstanding > 0 && due.getTime() < now.getTime();

export const paidTotal = (payments: InstallmentPayment[]) => round2(payments.filter((p) => !p.voided).reduce((s, p) => s + p.amount, 0));
export const outstandingBalance = (total: number, payments: InstallmentPayment[]) => Math.max(0, round2(total - paidTotal(payments)));
export const paymentStatusOf = (total: number, payments: InstallmentPayment[]): 'unpaid' | 'partial' | 'paid' => {
  const paid = paidTotal(payments);
  if (paid <= 0) return 'unpaid';
  return paid + 0.004 >= total ? 'paid' : 'partial';
};

/** A recorded installment must be positive and may not exceed what is still owed. */
export function validateInstallment(amount: number, total: number, payments: InstallmentPayment[]): string | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return 'Payment amount must be above 0';
  if (round2(amount) > outstandingBalance(total, payments) + 0.004) return 'Payment is more than the outstanding balance';
  return null;
}

/** Seller-set deposit: the amount that must be recorded before the order may ship (percent of total, 0 = none). */
export const depositRequired = (total: number, depositPercent?: number | null) =>
  typeof depositPercent === 'number' && depositPercent > 0 ? round2((total * Math.min(100, depositPercent)) / 100) : 0;

/** Credit limit check for a NEW net-terms order: outstanding + this order must stay within the limit (null/0 = no limit). */
export function creditLimitCheck(creditLimit: number | null | undefined, currentOutstanding: number, newOrderTotal: number): { ok: boolean; available: number | null } {
  if (!creditLimit || creditLimit <= 0) return { ok: true, available: null };
  const available = round2(creditLimit - currentOutstanding);
  return { ok: round2(currentOutstanding + newOrderTotal) <= creditLimit + 0.004, available: Math.max(0, available) };
}

/** Location values override the company's, field by field; an empty list/null falls back to the company. */
export function effectiveCompanySettings<T extends { catalogId?: string | null; paymentTerms?: PaymentTerms | null; allowedPaymentMethods?: string[] | null; creditLimit?: number | null }>(
  company: T, location?: Partial<T> | null,
) {
  return {
    catalogId: location?.catalogId ?? company.catalogId ?? null,
    paymentTerms: location?.paymentTerms ?? company.paymentTerms ?? null,
    allowedPaymentMethods: (location?.allowedPaymentMethods?.length ? location.allowedPaymentMethods : company.allowedPaymentMethods) ?? [],
    creditLimit: location?.creditLimit ?? company.creditLimit ?? null,
  };
}

/** Empty allow-list = every method the store offers. Otherwise only the listed ones. */
export const isPaymentMethodAllowed = (allowed: string[] | null | undefined, method: string) => !allowed || allowed.length === 0 || allowed.includes(method);

export const BUYER_ROLES = ['ordering', 'location_admin'] as const;
export type BuyerRole = (typeof BUYER_ROLES)[number];
/** Ordering-only buyers place orders; location admins also manage buyers, addresses and orders of THEIR location. */
export const canManageLocation = (role: BuyerRole, buyerLocationId: string, targetLocationId: string) => role === 'location_admin' && buyerLocationId === targetLocationId;
