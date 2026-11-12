/* eslint-disable prettier/prettier */
import { FbrInvoiceInput, FbrItemInput, isValidBuyerId, normalizeHsCode, normalizeNtnCnic, pktDate, rateString, round2 } from './fbr-di.util';

export interface PlatformSeller {
  ntn: string; legalName: string; address: string; province: string;
  scenarioId: string; hsCode: string; uom: string; saleType: string;
}
export interface BuyerParty {
  name: string; taxId: string | null | undefined; taxRegistered: boolean; address: string; province: string;
}

/**
 * A paid Solvexo plan invoice -> the FBR invoice Solvexo issues to the seller (the seller is the BUYER here).
 * Plan invoices are stored in USD; FBR wants rupees, so every amount is converted at ONE rate that the caller freezes.
 * ASSUMED: net/tax/total are reported exactly as invoiced; no further/extra tax (services) and no SRO.
 */
export function buildPlanInvoiceInput(p: {
  invoice: { amountUSD: number; subtotalUSD: number | null; taxAmountUSD: number; taxRatePercent: number; paidAt: Date | null; createdAt?: Date };
  planName: string; fxPKRPerUSD: number; seller: PlatformSeller; buyer: BuyerParty;
  /** Item text; defaults to the plan wording. Other Solvexo charges (add-ons, fee bills, ...) pass their own. */
  description?: string;
}): { input: FbrInvoiceInput; netPKR: number; taxPKR: number } {
  const { invoice, seller, buyer } = p;
  const netUSD = invoice.subtotalUSD ?? invoice.amountUSD - (invoice.taxAmountUSD ?? 0);
  const netPKR = round2(netUSD * p.fxPKRPerUSD);
  const taxPKR = round2((invoice.taxAmountUSD ?? 0) * p.fxPKRPerUSD);
  const buyerNtn = buyer.taxRegistered ? normalizeNtnCnic(buyer.taxId) : '';
  const registered = buyerNtn.length > 0;
  const item: FbrItemInput = {
    hsCode: normalizeHsCode(seller.hsCode),
    productDescription: p.description ?? `Solvexo ${p.planName} plan subscription`,
    rate: rateString(invoice.taxRatePercent),
    uoM: seller.uom,
    quantity: 1,
    totalValues: round2(netPKR + taxPKR),
    valueSalesExcludingST: netPKR,
    salesTaxApplicable: taxPKR,
    saleType: seller.saleType,
  };
  return {
    netPKR, taxPKR,
    input: {
      invoiceType: 'Sale Invoice',
      invoiceDate: pktDate(invoice.paidAt ?? invoice.createdAt ?? new Date()),
      sellerNTNCNIC: normalizeNtnCnic(seller.ntn), sellerBusinessName: seller.legalName, sellerProvince: seller.province, sellerAddress: seller.address,
      buyerNTNCNIC: registered ? buyerNtn : null, buyerBusinessName: buyer.name, buyerProvince: buyer.province, buyerAddress: buyer.address,
      buyerRegistrationType: registered ? 'Registered' : 'Unregistered',
      scenarioId: seller.scenarioId,
      items: [item],
    },
  };
}

export interface StoreSeller {
  taxId: string | null | undefined; taxRegistered: boolean; legalName: string; address: string; province: string;
  scenarioId: string; hsCode: string; uom: string; saleType: string;
}
export interface OrderLike {
  orderNumber: string; createdAt?: Date | string; currency: string;
  shippingAddress?: { recipientName?: string; addressLine1?: string; addressLine2?: string | null; city?: string; state?: string } | null;
}
export interface SellerOrderItemLike {
  name: string; variantId?: string | null; quantity: number; totalPrice: number;
  couponDiscountUSD?: number; campaignDiscountUSD?: number; autoDiscountUSD?: number;
  taxUSD?: number; includedTaxUSD?: number; status?: string; type?: string;
}

/** The share of a rupee-priced line that is net sales, and the tax on it. Item amounts are in the ORDER currency despite the *USD field names. */
export function lineAmounts(it: SellerOrderItemLike): { net: number; tax: number } {
  const discount = (it.couponDiscountUSD ?? 0) + (it.campaignDiscountUSD ?? 0) + (it.autoDiscountUSD ?? 0);
  const included = it.includedTaxUSD ?? 0;
  const added = it.taxUSD ?? 0;
  // Prices that already contain tax: take that tax out of the net. ASSUMED: discounts reduce the net sales value.
  const net = Math.max(0, it.totalPrice - discount - included);
  return { net: round2(net), tax: round2(added + included) };
}

/** "18%" when the actual tax on the line is within 0.1 point of a whole percentage, otherwise the exact figure. */
export function rateForLine(net: number, tax: number): string {
  if (!(net > 0)) return '0%';
  const pct = (tax / net) * 100;
  const whole = Math.round(pct);
  return Math.abs(pct - whole) <= 0.1 ? rateString(whole) : rateString(pct);
}

/**
 * One store's part of an order -> the FBR invoice the STORE issues to its customer (an unregistered consumer).
 * ASSUMED: cancelled lines are left out, shipping is not reported as its own line, pickup orders use the store's own
 * province/address as the buyer's. Only PKR orders are reported (checked by the caller).
 */
export function buildOrderInput(p: {
  order: OrderLike; items: SellerOrderItemLike[]; hsByVariant: Record<string, string | null | undefined>;
  seller: StoreSeller; storeName: string;
  /** Wholesale (B2B) order: the company the order was placed for. Null/undefined for a retail order. */
  b2b?: { companyName?: string | null; taxId?: string | null } | null;
}): { input: FbrInvoiceInput; netTotal: number; taxTotal: number; buyerIssues: string[] } {
  const { order, seller } = p;
  const live = p.items.filter((i) => i.status !== 'cancelled' && i.status !== 'refunded');
  let netTotal = 0; let taxTotal = 0;
  const items: FbrItemInput[] = live.map((it) => {
    const { net, tax } = lineAmounts(it);
    netTotal += net; taxTotal += tax;
    const hs = normalizeHsCode(it.variantId ? p.hsByVariant[it.variantId] : null) || normalizeHsCode(seller.hsCode);
    return {
      hsCode: hs, productDescription: it.name, rate: rateForLine(net, tax), uoM: seller.uom, quantity: it.quantity,
      totalValues: round2(net + tax), valueSalesExcludingST: net, salesTaxApplicable: tax, saleType: seller.saleType,
    };
  });
  const a = order.shippingAddress;
  const addressText = a ? [a.addressLine1, a.addressLine2, a.city].filter(Boolean).join(', ') : '';
  const buyerIssues: string[] = [];
  let buyer: { name: string; ntn: string | null; registration: 'Registered' | 'Unregistered'; province: string; address: string };
  if (p.b2b) {
    // Wholesale buyer: use ONLY what the order and the company record say. Nothing is guessed (no store address as the buyer's).
    const companyName = (p.b2b.companyName ?? '').trim();
    if (!companyName) buyerIssues.push('The wholesale company name is missing, so the buyer cannot be named on the invoice.');
    const rawTax = (p.b2b.taxId ?? '').trim();
    let ntn: string | null = null;
    if (rawTax) {
      const normalized = normalizeNtnCnic(rawTax);
      if (isValidBuyerId(normalized)) ntn = normalized;
      else buyerIssues.push(`The company's tax ID "${rawTax}" is not a valid NTN/CNIC (7, 9 or 13 digits). Correct it in Wholesale → Companies.`);
    }
    if (!a || !a.state?.trim() || !addressText) buyerIssues.push('This wholesale order has no delivery address with a province, so the buyer details are incomplete.');
    buyer = { name: companyName, ntn, registration: ntn ? 'Registered' : 'Unregistered', province: a?.state?.trim() ?? '', address: addressText };
  } else {
    // Retail customer. ASSUMED: a pickup order has no delivery address, so the store's own province/address stand in for the buyer's.
    buyer = {
      name: a?.recipientName?.trim() || 'Retail customer', ntn: null, registration: 'Unregistered',
      province: a?.state?.trim() || seller.province, address: addressText || seller.address,
    };
  }
  return {
    netTotal: round2(netTotal), taxTotal: round2(taxTotal), buyerIssues,
    input: {
      invoiceType: 'Sale Invoice',
      // Date of supply, as a Pakistani calendar date. ASSUMED: for an order this is the order date (invoices are filed shortly after the order).
      invoiceDate: pktDate(order.createdAt ? new Date(order.createdAt) : new Date()),
      sellerNTNCNIC: normalizeNtnCnic(seller.taxId), sellerBusinessName: seller.legalName || p.storeName, sellerProvince: seller.province, sellerAddress: seller.address,
      buyerNTNCNIC: buyer.ntn, buyerBusinessName: buyer.name,
      buyerProvince: buyer.province, buyerAddress: buyer.address,
      buyerRegistrationType: buyer.registration,
      scenarioId: seller.scenarioId,
      items,
    },
  };
}
