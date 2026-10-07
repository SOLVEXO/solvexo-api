/* eslint-disable prettier/prettier */
/**
 * Pure Shopify-style tax rules (no DB, no network):
 *  - tax-inclusive pricing ("Include tax in all prices", per-country override on a tax region)
 *  - tax overrides (different rate for products in given collections / categories, optionally per country/state)
 *  - per-variant "Charge tax on this product" (taxable) flag
 * Money convention (matches CheckoutService.checkoutTotal): `added` tax is ADDED on top of the line price and is what
 * item.taxUSD / checkout.taxAmount carry; `included` tax is already INSIDE the price (never added again) and is kept
 * separately (item.includedTaxUSD / checkout.includedTaxAmount) for display, receipts and tax reports.
 */
import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';

export interface TaxRegionEntry { country: string; state: string | null; rate: number; pricesIncludeTax?: boolean | null }
export interface TaxOverrideEntry {
  id: string; name: string; country: string | null; state: string | null; rate: number;
  collectionIds: string[]; categoryIds: string[];
}
export interface StoreTaxConfig {
  taxRate?: number | null;
  taxRegions?: TaxRegionEntry[] | null;
  taxPricesIncludeTax?: boolean | null;
  taxOverrides?: TaxOverrideEntry[] | null;
}
export interface TaxAddress { country?: string | null; state?: string | null }
export interface TaxItemContext { taxable?: boolean | null; categoryId?: string | null; collectionIds?: string[] | null }

const r2 = (n: number) => Math.round(n * 100) / 100;
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/** Country+state match wins over a country-only entry; null when no region applies. */
export function findTaxRegion(regions: TaxRegionEntry[] | null | undefined, address: TaxAddress | null | undefined): TaxRegionEntry | null {
  if (!address?.country || !regions || regions.length === 0) return null;
  const country = norm(address.country);
  const state = address.state ? norm(address.state) : null;
  const exact = regions.find((r) => norm(r.country) === country && r.state && norm(r.state) === state);
  if (exact) return exact;
  return regions.find((r) => norm(r.country) === country && !r.state) ?? null;
}

/** Does the buyer see tax-inclusive prices? A region's explicit true/false beats the store-wide setting. */
export function pricesIncludeTaxFor(cfg: StoreTaxConfig, address: TaxAddress | null | undefined): boolean {
  const region = findTaxRegion(cfg.taxRegions, address);
  if (region && typeof region.pricesIncludeTax === 'boolean') return region.pricesIncludeTax;
  return !!cfg.taxPricesIncludeTax;
}

/** Base (non-override) percentage for the address: region rate, else the flat store rate. */
export function baseTaxRate(cfg: StoreTaxConfig, address: TaxAddress | null | undefined): number {
  return findTaxRegion(cfg.taxRegions, address)?.rate ?? cfg.taxRate ?? 0;
}

/** Best matching override for an item at an address: most specific geography wins (state > country > everywhere). */
export function findTaxOverride(cfg: StoreTaxConfig, address: TaxAddress | null | undefined, item: TaxItemContext): TaxOverrideEntry | null {
  const list = cfg.taxOverrides ?? [];
  if (list.length === 0) return null;
  const collections = new Set((item.collectionIds ?? []).map(String));
  const country = address?.country ? norm(address.country) : null;
  const state = address?.state ? norm(address.state) : null;
  let best: { o: TaxOverrideEntry; score: number } | null = null;
  for (const o of list) {
    const hits = (item.categoryId && (o.categoryIds ?? []).map(String).includes(String(item.categoryId)))
      || (o.collectionIds ?? []).some((c) => collections.has(String(c)));
    if (!hits) continue;
    let score = 0;
    if (o.country) {
      if (!country || norm(o.country) !== country) continue;
      score = 1;
      if (o.state) { if (!state || norm(o.state) !== state) continue; score = 2; }
    }
    if (!best || score > best.score) best = { o, score };
  }
  return best?.o ?? null;
}

/** Effective percentage for one item: 0 when not taxable, else the matching override, else region/flat rate. */
export function resolveItemTaxRate(cfg: StoreTaxConfig, address: TaxAddress | null | undefined, item: TaxItemContext): number {
  if (item.taxable === false) return 0;
  const override = findTaxOverride(cfg, address, item);
  return override ? override.rate : baseTaxRate(cfg, address);
}

/** Tax on a line: `added` when prices exclude tax (added on top), `included` when it is extracted from the price. */
export function splitLineTax(lineTotal: number, ratePercent: number, included: boolean): { added: number; included: number } {
  if (!(lineTotal > 0) || !(ratePercent > 0)) return { added: 0, included: 0 };
  if (included) return { added: 0, included: r2(lineTotal - lineTotal / (1 + ratePercent / 100)) };
  return { added: r2(lineTotal * (ratePercent / 100)), included: 0 };
}

/** Validates + normalises the `taxOverrides` array a seller sends (ids generated when missing). */
export function parseTaxOverrides(raw: unknown): TaxOverrideEntry[] {
  if (!Array.isArray(raw)) throw new BadRequestException('taxOverrides must be an array');
  if (raw.length > 50) throw new BadRequestException('At most 50 tax overrides can be saved.');
  const ids = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))].slice(0, 200) : []);
  return raw.map((o: any) => {
    const rate = Number(o?.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new BadRequestException('Tax override rate must be between 0 and 100');
    const collectionIds = ids(o?.collectionIds);
    const categoryIds = ids(o?.categoryIds);
    if (collectionIds.length + categoryIds.length === 0) throw new BadRequestException('Each tax override needs at least one collection or category');
    const country = o?.country ? String(o.country).trim() : null;
    const state = country && o?.state ? String(o.state).trim() : null;
    return {
      id: typeof o?.id === 'string' && o.id.trim() ? o.id.trim().slice(0, 40) : randomBytes(6).toString('hex'),
      name: String(o?.name ?? '').trim().slice(0, 80),
      country: country || null, state: state || null, rate, collectionIds, categoryIds,
    };
  });
}

/** Ids of the collections a product belongs to: manual `productIds` list, or an automatic collection's rules
 *  (category and/or tags, matchType all|any — same semantics as the collection page). */
export function collectionIdsForProduct(
  product: { id: string; categoryId: string | null; tags: string[] },
  collections: { _id?: unknown; id?: unknown; type?: string; productIds?: string[]; rules?: { categoryId?: string | null; tags?: string[]; matchType?: 'all' | 'any' } | null }[],
): string[] {
  const out: string[] = [];
  const tags = new Set((product.tags ?? []).map((t) => norm(t)));
  for (const c of collections) {
    const id = String(c._id ?? c.id);
    if (c.type === 'automatic') {
      const rules = c.rules ?? {};
      const checks: boolean[] = [];
      if (rules.categoryId) checks.push(!!product.categoryId && String(rules.categoryId) === String(product.categoryId));
      const ruleTags = (rules.tags ?? []).map((t) => norm(t)).filter(Boolean);
      if (ruleTags.length > 0) checks.push(rules.matchType === 'all' ? ruleTags.every((t) => tags.has(t)) : ruleTags.some((t) => tags.has(t)));
      if (checks.length > 0 && (rules.matchType === 'all' ? checks.every(Boolean) : checks.some(Boolean))) out.push(id);
    } else if ((c.productIds ?? []).map(String).includes(product.id)) {
      out.push(id);
    }
  }
  return out;
}
