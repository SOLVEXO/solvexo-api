/* eslint-disable prettier/prettier */
// Pure helpers for Solvexo's OWN tax (on platform-plan fees charged to sellers). Store/customer tax lives in
// `tax/tax-rules.util.ts` and is unrelated.

export type PlatformTaxAuthority = 'FBR' | 'SRB' | 'PRA' | 'KPRA' | 'BRA' | 'OTHER';
export const PLATFORM_TAX_AUTHORITIES: PlatformTaxAuthority[] = ['FBR', 'SRB', 'PRA', 'KPRA', 'BRA', 'OTHER'];

export type PlatformTaxRate = {
  id: string;
  country: string; // ISO-3166 alpha-2, upper case
  label: string; // shown on the invoice, e.g. "Sales Tax"
  ratePercent: number; // 0-100
  status: 'draft' | 'confirmed'; // only confirmed rates are ever charged
  effectiveFrom: Date | string | null; // null = always
  stripeTaxRateId?: string | null;
};

export type PlatformTaxPick =
  | { rate: PlatformTaxRate; reason: 'ok' }
  | { rate: null; reason: 'no_country' | 'not_listed' | 'not_confirmed' | 'not_effective' | 'zero' };

/** Which rate applies to a seller of `country` at time `at`. A draft rate is never charged; a country that is not listed is never silently taxed. */
export function pickPlatformTaxRate(rates: PlatformTaxRate[] | undefined | null, country: string | null | undefined, at: Date = new Date()): PlatformTaxPick {
  const cc = String(country ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return { rate: null, reason: 'no_country' };
  const listed = (rates ?? []).filter((r) => String(r.country).toUpperCase() === cc);
  if (!listed.length) return { rate: null, reason: 'not_listed' };
  const confirmed = listed.filter((r) => r.status === 'confirmed');
  if (!confirmed.length) return { rate: null, reason: 'not_confirmed' };
  const t = at.getTime();
  const effective = confirmed
    .map((r) => ({ r, from: r.effectiveFrom ? new Date(r.effectiveFrom).getTime() : 0 }))
    .filter((x) => x.from <= t)
    .sort((a, b) => b.from - a.from);
  if (!effective.length) return { rate: null, reason: 'not_effective' };
  const best = effective[0].r;
  if (!(best.ratePercent > 0)) return { rate: null, reason: 'zero' };
  return { rate: best, reason: 'ok' };
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Tax added on top of a net amount (Stripe "exclusive" tax rate behaviour, rounded to the cent). */
export function taxOnNet(netUSD: number, ratePercent: number): { taxUSD: number; totalUSD: number } {
  const taxUSD = Math.round(netUSD * 100 * (ratePercent / 100)) / 100;
  return { taxUSD, totalUSD: round2(netUSD + taxUSD) };
}

/** Tax cents on a Stripe invoice, whichever API shape it arrives in (legacy `tax`, `total_tax_amounts`, Basil+ `total_taxes`). */
export function getInvoiceTaxCents(invoice: any): number {
  if (!invoice) return 0;
  if (typeof invoice.tax === 'number') return invoice.tax;
  const sum = (arr: any) => (Array.isArray(arr) ? arr.reduce((s, x) => s + (Number(x?.amount) || 0), 0) : null);
  return sum(invoice.total_tax_amounts) ?? sum(invoice.total_taxes) ?? 0;
}

/** Tax snapshot of a paid Stripe invoice: `amountUSD` is the TOTAL paid, the tax is carved out of it, the rate is derived from the amounts. */
export function invoiceTaxSnapshot(invoice: any, amountUSD: number): { subtotalUSD: number; taxAmountUSD: number; taxRatePercent: number } {
  const taxAmountUSD = Math.min(amountUSD, round2(getInvoiceTaxCents(invoice) / 100));
  const subtotalUSD = round2(amountUSD - taxAmountUSD);
  const taxRatePercent = taxAmountUSD > 0 && subtotalUSD > 0 ? Math.round((taxAmountUSD / subtotalUSD) * 10000) / 100 : 0;
  return { subtotalUSD, taxAmountUSD, taxRatePercent };
}

const TAX_ID_RE = /^[A-Za-z0-9][A-Za-z0-9 .\-/]{0,29}$/;
export const isValidTaxId = (v: string) => TAX_ID_RE.test(v.trim());
