/* eslint-disable prettier/prettier */
/** Pure rules for seller-managed search: synonyms, pinned products, filter settings. */

export const norm = (s: unknown): string => String(s ?? '').toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
export const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const MAX_SYNONYM_GROUPS = 100;
export const MAX_TERMS_PER_GROUP = 12;
export const MAX_PINNED_QUERIES = 50;
export const MAX_PINNED_PRODUCTS = 12;

/** Cleans seller input: lowercased, deduped, a group needs two or more distinct terms. */
export function cleanSynonymGroups(input: unknown): { terms: string[] }[] {
  if (!Array.isArray(input)) throw new Error('Synonyms must be a list');
  const out: { terms: string[] }[] = [];
  for (const g of input.slice(0, MAX_SYNONYM_GROUPS)) {
    const raw: unknown[] = Array.isArray((g as any)?.terms) ? (g as any).terms : [];
    const terms = [...new Set(raw.map((t) => norm(t).slice(0, 40)).filter(Boolean))].slice(0, MAX_TERMS_PER_GROUP);
    if (terms.length >= 2) out.push({ terms });
  }
  return out;
}

/**
 * The search terms to look for: the typed query plus, for every synonym group that contains the whole query or one of its words,
 * the other terms of that group. The typed query always comes first. Capped so a big group cannot blow up the query.
 */
export function expandQuery(groups: { terms: string[] }[], query: string, cap = 12): string[] {
  const q = norm(query);
  if (!q) return [];
  const words = new Set(q.split(' '));
  const out = [q];
  for (const g of groups ?? []) {
    const hit = g.terms.includes(q) || g.terms.some((t) => words.has(t));
    if (!hit) continue;
    for (const t of g.terms) if (!out.includes(t)) out.push(t);
    if (out.length >= cap) break;
  }
  return out.slice(0, cap);
}

/** One regex source that matches any of the terms (each escaped). */
export const termsRegexSource = (terms: string[]): string => terms.map(escapeRx).join('|');

export function cleanPinned(input: unknown): { query: string; productIds: string[] }[] {
  if (!Array.isArray(input)) throw new Error('Pinned products must be a list');
  const seen = new Set<string>(); const out: { query: string; productIds: string[] }[] = [];
  for (const p of input.slice(0, MAX_PINNED_QUERIES)) {
    const query = norm((p as any)?.query).slice(0, 80);
    const ids = [...new Set((Array.isArray((p as any)?.productIds) ? (p as any).productIds : []).map(String).filter((x: string) => /^[0-9a-f]{24}$/i.test(x)))].slice(0, MAX_PINNED_PRODUCTS) as string[];
    if (!query || ids.length === 0 || seen.has(query)) continue;
    seen.add(query); out.push({ query, productIds: ids });
  }
  return out;
}

/** Pinned products shown first for exactly this query (also when the query is one of its synonyms' spellings). */
export function pinnedFor(pinned: { query: string; productIds: string[] }[], terms: string[]): string[] {
  const out: string[] = [];
  for (const p of pinned ?? []) if (terms.includes(p.query)) for (const id of p.productIds) if (!out.includes(id)) out.push(id);
  return out;
}

export const FILTER_KEYS = ['availability', 'price', 'vendor', 'tags', 'options'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export interface FilterSetting { key: FilterKey; enabled: boolean }
export const defaultFilters = (): FilterSetting[] => FILTER_KEYS.map((key) => ({ key, enabled: true }));

/** Seller order + on/off; unknown keys are dropped and missing ones appended enabled (so a new filter never disappears). */
export function cleanFilters(input: unknown): FilterSetting[] {
  if (!Array.isArray(input)) throw new Error('Filters must be a list');
  const out: FilterSetting[] = [];
  for (const f of input) { const key = (f as any)?.key; if ((FILTER_KEYS as readonly string[]).includes(key) && !out.some((o) => o.key === key)) out.push({ key, enabled: (f as any)?.enabled !== false }); }
  for (const key of FILTER_KEYS) if (!out.some((o) => o.key === key)) out.push({ key, enabled: true });
  return out;
}

/** A search worth reporting: 2+ characters, not just digits/punctuation noise. */
export const reportableQuery = (q: unknown): string | null => { const n = norm(q).slice(0, 80); return n.length >= 2 && /[\p{L}\p{N}]/u.test(n) ? n : null; };
