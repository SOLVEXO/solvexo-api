/* eslint-disable prettier/prettier */

/**
 * Pure helpers for Solvexo's own website analytics (Google Analytics 4 on the public site + sign-up).
 * SiteAnalyticsService does the I/O against the GA4 Data API.
 */

/** Where a cookie consent banner is required before analytics may run: EU + EEA + UK + Switzerland. */
export const CONSENT_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', // EU 27
  'IS', 'LI', 'NO', // EEA
  'GB', 'CH',
]);

export const consentRequired = (country: string | null | undefined) => !!country && CONSENT_COUNTRIES.has(country.toUpperCase());

/** A GA4 web stream measurement id, e.g. G-AB12CD34EF. */
export const MEASUREMENT_ID_RE = /^G-[A-Z0-9]{4,16}$/;

export type SiteRange = '7d' | '28d' | '90d' | '365d';
export const SITE_RANGES: SiteRange[] = ['7d', '28d', '90d', '365d'];
export const rangeDays = (r: SiteRange) => Number(r.replace('d', ''));

/** GA4 relative date ranges for a period and the same-length period before it (in the property's time zone). */
export function dateRanges(range: SiteRange) {
  const n = rangeDays(range);
  return {
    current: { startDate: `${n - 1}daysAgo`, endDate: 'today' },
    previous: { startDate: `${2 * n - 1}daysAgo`, endDate: `${n}daysAgo` },
  };
}

export interface Ga4Report {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string }[];
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  totals?: { metricValues?: { value?: string }[] }[];
}

/** Rows of a GA4 report as plain objects: dimension values as strings, metric values as numbers. */
export function reportRows(report: Ga4Report | null | undefined): Record<string, string | number>[] {
  const dims = (report?.dimensionHeaders ?? []).map((h) => h.name);
  const mets = (report?.metricHeaders ?? []).map((h) => h.name);
  return (report?.rows ?? []).map((row) => {
    const o: Record<string, string | number> = {};
    dims.forEach((d, i) => { o[d] = row.dimensionValues?.[i]?.value ?? ''; });
    mets.forEach((m, i) => { o[m] = num(row.metricValues?.[i]?.value); });
    return o;
  });
}

/** The single row of a report without dimensions (or its totals row), as metric name → number. */
export function reportTotals(report: Ga4Report | null | undefined): Record<string, number> {
  const mets = (report?.metricHeaders ?? []).map((h) => h.name);
  const values = report?.totals?.[0]?.metricValues ?? report?.rows?.[0]?.metricValues ?? [];
  return Object.fromEntries(mets.map((m, i) => [m, num(values[i]?.value)]));
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Percent change from `prev` to `cur`, one decimal; null when there is nothing to compare with. */
export const change = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

/** The last `n` days as GA4 date keys (YYYYMMDD), oldest first, ending today (UTC). */
export function lastDays(n: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  return out;
}

/** "20261103" → "2026-11-03". */
export const isoDay = (k: string) => (/^\d{8}$/.test(k) ? `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}` : k);

/** GA4 placeholders that mean "no value" rather than a real name. */
export const isNotSet = (v: unknown) => ['(not set)', '(none)', '(direct)', '(other)', ''].includes(String(v ?? '').trim());
