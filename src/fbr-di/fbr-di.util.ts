/* eslint-disable prettier/prettier */
import { createHash } from 'crypto';

/**
 * FBR Digital Invoicing (PRAL "Technical Specification for DI API" v1.12, 7-Apr-2025) — pure helpers.
 * Everything here follows that document literally; where the document is silent the choice is marked ASSUMED
 * so it can be checked in the FBR sandbox before going live.
 */

export type FbrMode = 'sandbox' | 'production';

// Section 4.1 / 4.2 (sandbox URLs carry the _sb suffix; production URLs do not).
export const FBR_URLS: Record<FbrMode, { post: string; validate: string }> = {
  sandbox: {
    post: 'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata_sb',
    validate: 'https://gw.fbr.gov.pk/di_data/v1/di/validateinvoicedata_sb',
  },
  production: {
    post: 'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata',
    validate: 'https://gw.fbr.gov.pk/di_data/v1/di/validateinvoicedata',
  },
};

// Section 5 reference APIs (GET, same Bearer token).
export const FBR_REFERENCE_URLS = {
  provinces: 'https://gw.fbr.gov.pk/pdi/v1/provinces',
  uom: 'https://gw.fbr.gov.pk/pdi/v1/uom',
} as const;

/** Section 4.1: invoiceType is "Sale Invoice" or "Debit Note". */
export type FbrInvoiceType = 'Sale Invoice' | 'Debit Note';
export type FbrBuyerRegistration = 'Registered' | 'Unregistered';

export interface FbrItemInput {
  hsCode: string;
  productDescription: string;
  /** Rate text exactly as the rate reference API prints it, e.g. "18%". */
  rate: string;
  uoM: string;
  quantity: number;
  /** Total sales value including tax. */
  totalValues: number;
  valueSalesExcludingST: number;
  fixedNotifiedValueOrRetailPrice?: number;
  salesTaxApplicable: number;
  salesTaxWithheldAtSource?: number;
  extraTax?: number;
  furtherTax?: number;
  sroScheduleNo?: string;
  fedPayable?: number;
  discount?: number;
  saleType: string;
  sroItemSerialNo?: string;
}

export interface FbrInvoiceInput {
  invoiceType: FbrInvoiceType;
  /** YYYY-MM-DD */
  invoiceDate: string;
  sellerNTNCNIC: string;
  sellerBusinessName: string;
  sellerProvince: string;
  sellerAddress: string;
  buyerNTNCNIC?: string | null;
  buyerBusinessName: string;
  buyerProvince: string;
  buyerAddress: string;
  buyerRegistrationType: FbrBuyerRegistration;
  /** Only for a debit note: the FBR invoice number of the original sale (22 digits NTN / 28 digits CNIC). */
  invoiceRefNo?: string;
  /** Sandbox only (spec section 9). */
  scenarioId?: string;
  items: FbrItemInput[];
}

export const round2 = (n: number): number => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Digits only. A Pakistani NTN is often written with a check digit ("1234567-8"): the spec wants 7 digits, so an 8-digit
 * value is cut to its first 7 (ASSUMED: the last digit is the check digit). 7, 9 and 13 digit values are kept.
 */
export function normalizeNtnCnic(raw: string | null | undefined): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 8) return digits.slice(0, 7);
  return digits;
}

export const isValidSellerId = (v: string): boolean => /^(\d{7}|\d{13})$/.test(v);
export const isValidBuyerId = (v: string): boolean => /^(\d{7}|\d{9}|\d{13})$/.test(v);

/** "0101.2100" format. Eight digits without the dot are accepted and re-formatted; anything else is rejected (returns ''). */
export function normalizeHsCode(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (/^\d{4}\.\d{4}$/.test(s)) return s;
  const digits = s.replace(/\D/g, '');
  return digits.length === 8 ? `${digits.slice(0, 4)}.${digits.slice(4)}` : '';
}

/** Rate text in the form the rate reference API uses ("18%", "0%", "17.5%"). */
export function rateString(percent: number): string {
  const p = round2(percent);
  return `${Number.isInteger(p) ? p : String(p)}%`;
}

/** YYYY-MM-DD in Pakistan time (the invoice date FBR sees is a Pakistani calendar date). */
export function pktDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Problems that would make FBR reject the invoice, found BEFORE any call so the user gets a clear message. */
export function validateInvoiceInput(i: FbrInvoiceInput): string[] {
  const p: string[] = [];
  if (i.invoiceType !== 'Sale Invoice' && i.invoiceType !== 'Debit Note') p.push('Invoice type must be "Sale Invoice" or "Debit Note".');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.invoiceDate)) p.push('Invoice date must be YYYY-MM-DD.');
  if (!isValidSellerId(i.sellerNTNCNIC)) p.push('Seller NTN/CNIC must be 7 or 13 digits.');
  if (!i.sellerBusinessName?.trim()) p.push('Seller business name is missing.');
  if (!i.sellerProvince?.trim()) p.push('Seller province is missing.');
  if (!i.sellerAddress?.trim()) p.push('Seller address is missing.');
  if (i.buyerRegistrationType !== 'Registered' && i.buyerRegistrationType !== 'Unregistered') p.push('Buyer registration type must be Registered or Unregistered.');
  if (i.buyerRegistrationType === 'Registered') {
    if (!i.buyerNTNCNIC || !isValidBuyerId(i.buyerNTNCNIC)) p.push('A registered buyer needs an NTN/CNIC of 7, 9 or 13 digits.');
  } else if (i.buyerNTNCNIC && !isValidBuyerId(i.buyerNTNCNIC)) {
    p.push('Buyer NTN/CNIC must be 7, 9 or 13 digits (or left empty for an unregistered buyer).');
  }
  if (i.buyerNTNCNIC && i.buyerNTNCNIC === i.sellerNTNCNIC) p.push('Buyer and seller registration numbers are the same (self-invoicing is not allowed).');
  if (!i.buyerBusinessName?.trim()) p.push('Buyer name is missing.');
  if (!i.buyerProvince?.trim()) p.push('Buyer province is missing.');
  if (!i.buyerAddress?.trim()) p.push('Buyer address is missing.');
  if (i.invoiceType === 'Debit Note' && !i.invoiceRefNo?.trim()) p.push('A debit note needs the original FBR invoice number.');
  if (!i.items?.length) p.push('The invoice has no items.');
  (i.items ?? []).forEach((it, idx) => {
    const n = idx + 1;
    if (!/^\d{4}\.\d{4}$/.test(it.hsCode ?? '')) p.push(`Item ${n}: HS code must look like 0101.2100.`);
    if (!it.productDescription?.trim()) p.push(`Item ${n}: description is missing.`);
    if (!it.rate?.trim()) p.push(`Item ${n}: tax rate is missing.`);
    if (!it.uoM?.trim()) p.push(`Item ${n}: unit of measure is missing.`);
    if (!it.saleType?.trim()) p.push(`Item ${n}: sale type is missing.`);
    if (!(it.quantity > 0)) p.push(`Item ${n}: quantity must be above zero.`);
    for (const k of ['totalValues', 'valueSalesExcludingST', 'salesTaxApplicable'] as const) {
      if (!Number.isFinite(it[k]) || it[k] < 0) p.push(`Item ${n}: ${k} is not a valid amount.`);
    }
  });
  return p;
}

/** The JSON body for postinvoicedata / validateinvoicedata, field order as in the spec. scenarioId only in sandbox. */
export function buildPayload(i: FbrInvoiceInput, mode: FbrMode): Record<string, unknown> {
  const body: Record<string, unknown> = {
    invoiceType: i.invoiceType,
    invoiceDate: i.invoiceDate,
    sellerNTNCNIC: i.sellerNTNCNIC,
    sellerBusinessName: i.sellerBusinessName,
    sellerProvince: i.sellerProvince,
    sellerAddress: i.sellerAddress,
  };
  if (i.buyerNTNCNIC) body.buyerNTNCNIC = i.buyerNTNCNIC;
  body.buyerBusinessName = i.buyerBusinessName;
  body.buyerProvince = i.buyerProvince;
  body.buyerAddress = i.buyerAddress;
  body.buyerRegistrationType = i.buyerRegistrationType;
  body.invoiceRefNo = i.invoiceType === 'Debit Note' ? (i.invoiceRefNo ?? '') : '';
  if (mode === 'sandbox') body.scenarioId = i.scenarioId || 'SN002';
  body.items = i.items.map((it) => ({
    hsCode: it.hsCode,
    productDescription: it.productDescription,
    rate: it.rate,
    uoM: it.uoM,
    quantity: Math.round(it.quantity * 10000) / 10000,
    totalValues: round2(it.totalValues),
    valueSalesExcludingST: round2(it.valueSalesExcludingST),
    fixedNotifiedValueOrRetailPrice: round2(it.fixedNotifiedValueOrRetailPrice ?? 0),
    salesTaxApplicable: round2(it.salesTaxApplicable),
    salesTaxWithheldAtSource: round2(it.salesTaxWithheldAtSource ?? 0),
    extraTax: round2(it.extraTax ?? 0),
    furtherTax: round2(it.furtherTax ?? 0),
    sroScheduleNo: it.sroScheduleNo ?? '',
    fedPayable: round2(it.fedPayable ?? 0),
    discount: round2(it.discount ?? 0),
    saleType: it.saleType,
    sroItemSerialNo: it.sroItemSerialNo ?? '',
  }));
  return body;
}

export interface FbrResult {
  /** FBR accepted the invoice (post) / found it valid (validate). */
  ok: boolean;
  invoiceNumber: string | null;
  dated: string | null;
  /** Why it was not accepted: FBR error codes/messages, or a transport problem. */
  errors: { code: string | null; message: string; itemSNo?: string | null }[];
  /**
   * True ONLY when the request provably never reached FBR (DNS failure, connection refused, TLS refused before anything was
   * sent). Nothing can have been filed, so sending again automatically is safe.
   */
  retryable: boolean;
  /** Same fact spelled out: nothing was sent. */
  notSent: boolean;
  /**
   * The request may have reached FBR (timeout, reset, 5xx, unreadable answer, "valid" without a number): the invoice may or may
   * not be filed. FBR has no duplicate-check API, so this is NEVER resent automatically.
   */
  unknownOutcome: boolean;
  /** 401: the token is wrong/expired/for the other environment. */
  authError: boolean;
  /** Production filing is locked in this build: nothing was sent. */
  locked?: boolean;
  httpStatus: number | null;
}

/** Network error codes that happen BEFORE a request is sent (name lookup, TCP connect, TLS handshake). Anything else is "unknown". */
const NOT_SENT_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Turns a fetch() failure into a short message and the one fact that matters: could the request have reached FBR?
 * Our own timeout (AbortError), a reset connection and everything unrecognised count as "could have" (notSent = false).
 * The message never contains the URL or any header, so it can never leak a token.
 */
export function classifyNetworkError(e: any): { message: string; notSent: boolean } {
  if (e?.name === 'AbortError') return { message: 'timed out waiting for FBR', notSent: false };
  const code = String(e?.cause?.code ?? e?.code ?? '');
  const message = (code || String(e?.message ?? e ?? 'network error')).slice(0, 120);
  return { message, notSent: NOT_SENT_CODES.has(code) };
}

/**
 * Reads FBR's answer (spec 4.1.3-4.1.6). A response is only "ok" when the header status is 00/Valid AND every item
 * status is 00 — FBR can answer HTTP 200 with an invalid item (spec example 4.1.5).
 * Duplicate-safety (FBR has no "does this invoice exist?" call): only a request that provably never left (notSent) is
 * retryable; a timeout, 5xx, unreadable body or a "valid" answer without a number is an UNKNOWN outcome.
 */
export function interpretResponse(httpStatus: number | null, json: any, networkError?: string | null, requirePostNumber = true, notSent = false): FbrResult {
  const base: FbrResult = { ok: false, invoiceNumber: null, dated: null, errors: [], retryable: false, notSent: false, unknownOutcome: false, authError: false, httpStatus };
  const unknown = (message: string, extra: Partial<FbrResult> = {}): FbrResult => ({ ...base, ...extra, unknownOutcome: true, errors: [{ code: httpStatus === null ? null : String(httpStatus), message }] });
  if (networkError) {
    if (notSent) return { ...base, retryable: true, notSent: true, errors: [{ code: null, message: `Could not reach FBR (${networkError}). Nothing was sent, so it will be retried automatically.` }] };
    return unknown(`No clear answer from FBR (${networkError}). The invoice may or may not have been filed, so it is NOT sent again automatically. Check the FBR portal.`);
  }
  if (httpStatus === 401) return { ...base, authError: true, errors: [{ code: '401', message: 'FBR rejected the security token (unauthorized). Check that the token is correct, not expired, and matches the selected mode (sandbox / production).' }] };
  if (httpStatus === null || httpStatus >= 500) return unknown(`FBR answered with a server error (HTTP ${httpStatus ?? 'none'}). It may or may not have filed the invoice, so it is NOT sent again automatically. Check the FBR portal.`);
  const gatewayRefusal: FbrResult = { ...base, errors: [{ code: String(httpStatus), message: `FBR's gateway refused the request (HTTP ${httpStatus}) without details.` }] };
  if (!json || typeof json !== 'object') return httpStatus === 200 ? unknown('FBR returned an unreadable answer. The invoice may or may not have been filed, so it is NOT sent again automatically. Check the FBR portal.') : gatewayRefusal;

  const vr = json.validationResponse ?? null;
  const dated: string | null = typeof json.dated === 'string' ? json.dated : null;
  const invoiceNumber: string | null = typeof json.invoiceNumber === 'string' && json.invoiceNumber ? json.invoiceNumber : null;
  if (!vr) return httpStatus === 200 ? unknown('FBR answered without a validation result. The invoice may or may not have been filed, so it is NOT sent again automatically. Check the FBR portal.', { dated, invoiceNumber }) : { ...gatewayRefusal, dated };

  const errors: FbrResult['errors'] = [];
  if (vr.error || (vr.errorCode && vr.errorCode !== '')) errors.push({ code: vr.errorCode ?? null, message: String(vr.error || 'Rejected by FBR') });
  const statuses: any[] = Array.isArray(vr.invoiceStatuses) ? vr.invoiceStatuses : [];
  for (const s of statuses) {
    if (String(s?.statusCode) !== '00' || s?.error) {
      errors.push({ code: s?.errorCode ?? null, message: String(s?.error || 'Item rejected by FBR'), itemSNo: s?.itemSNo ?? null });
    }
  }
  const headerValid = String(vr.statusCode) === '00' && String(vr.status ?? '').toLowerCase() === 'valid';
  const itemsValid = statuses.every((s) => String(s?.statusCode) === '00');
  if (headerValid && itemsValid && errors.length === 0 && requirePostNumber && !invoiceNumber) {
    return unknown('FBR marked the invoice valid but returned no invoice number. It may be filed, so it is NOT sent again automatically. Check the FBR portal.', { dated });
  }
  const ok = headerValid && itemsValid && errors.length === 0;
  if (!ok && errors.length === 0) errors.push({ code: null, message: `FBR did not mark the invoice valid (status: ${vr.status ?? 'unknown'}).` });
  return { ...base, ok, invoiceNumber, dated, errors };
}

/**
 * The FBR invoice number as the spec shows it: 7-digit NTN (or 13-digit CNIC) + "DI" + 13 digits, i.e. 22 or 28 characters
 * (spec examples "7000007DI1747119701593"; "22 digits in case of NTN, 28 digits in case of CNIC"). ASSUMED pattern.
 */
export function isValidFbrInvoiceNumber(v: string): boolean {
  return /^(\d{7}|\d{13})DI\d{13}$/.test(String(v ?? '').trim());
}

/** First 12 hex characters of sha256(token): identifies WHICH token a sandbox test was run with, without storing the token. */
export function fbrTokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

export interface PlatformInvoiceTaxFacts { taxAmountUSD?: number | null; taxRatePercent?: number | null; taxCountry?: string | null; subtotalUSD?: number | null }

/**
 * Phase 0 rule for Solvexo's plan invoices (no ledger / rule packs yet): only an invoice whose tax was charged under Pakistani
 * rules (taxCountry = PK) and is above zero is queued, and only for the SANDBOX. Everything else is HELD with a reason, never
 * skipped and never treated as zero. A foreign customer is NOT excluded because of where they live: how a Pakistani entity must
 * report that supply needs a verified rule, which does not exist yet.
 */
export function platformInvoiceTreatment(inv: PlatformInvoiceTaxFacts): { eligible: boolean; reason: string | null } {
  if (inv.subtotalUSD === null || inv.subtotalUSD === undefined) {
    return { eligible: false, reason: 'The tax information for this invoice is missing (it was issued before tax was recorded). It is treated as UNKNOWN, not as zero.' };
  }
  const cc = String(inv.taxCountry ?? '').trim().toUpperCase();
  if (!cc) return { eligible: false, reason: 'The country whose tax rules were applied is missing, so how to report this invoice is unknown.' };
  if (cc !== 'PK') return { eligible: false, reason: `Tax was charged under ${cc} rules. How a Pakistani entity must report this supply is not verified yet (needs your accountant).` };
  if (!((inv.taxAmountUSD ?? 0) > 0) || !((inv.taxRatePercent ?? 0) > 0)) {
    return { eligible: false, reason: 'No tax was charged on this invoice. Whether this supply is zero-rated, exempt or out of scope is not verified yet (needs your accountant).' };
  }
  return { eligible: true, reason: null };
}

/** needs_info records are checked again every hour, for at most 14 days, without using up attempts. */
export const FBR_NEEDS_INFO_RETRY_MINUTES = 60;
export const FBR_NEEDS_INFO_MAX_DAYS = 14;
/** A record still marked "in flight" this long after it was claimed lost its worker (lease is 10 minutes, the HTTP timeout 25 seconds). */
export const FBR_STALE_IN_FLIGHT_MINUTES = 12;

/** Minutes to wait before attempt N+1 after a retryable failure: 5m, 15m, 1h, 6h, 24h, then daily. */
export function retryDelayMinutes(attemptsSoFar: number): number {
  const steps = [5, 15, 60, 360, 1440];
  return steps[Math.min(Math.max(attemptsSoFar - 1, 0), steps.length - 1)];
}

export const FBR_MAX_ATTEMPTS = 10;

/**
 * Text encoded in the QR printed on the invoice. The spec (section 6) fixes the size (QR version 2.0, 25x25, 1.0 x 1.0
 * inch) and says a QR must be printed, but does not say what it encodes — ASSUMED: the FBR invoice number.
 */
export function qrText(invoiceNumber: string): string {
  return invoiceNumber;
}

export function maskToken(token: string): string {
  return token.length <= 8 ? '••••' : `••••${token.slice(-4)}`;
}
