/* eslint-disable prettier/prettier */
/**
 * G4.5 — the unit price of a sale line, PURE, in minor units:
 *   base  = the price book's price for the variant when a book applies and lists it, else the variant's list price
 *   unit  = base + Σ price deltas of the chosen modifier options
 * Modifier choices are validated against the product's groups (each option must belong to a group attached to the product; per group at least `minSelect`
 * and at most `maxSelect` options; required groups must be answered). The SERVER always prices — the till only sends ids.
 */
export interface ModifierOption { id: string; name: string; priceDeltaMinor: number; active?: boolean }
export interface ModifierGroup { id: string; name: string; minSelect: number; maxSelect: number; options: ModifierOption[]; active?: boolean }
export interface ModifierChoice { groupId: string; optionIds: string[] }
export interface PricedModifier { groupId: string; groupName: string; optionId: string; name: string; priceDeltaMinor: number }
export type PricingError = { code: string; message: string };

export function priceLine(input: {
  listPriceMinor: number;
  bookPriceMinor?: number | null;
  groups: ModifierGroup[];
  choices?: ModifierChoice[] | null;
}): { ok: true; unitPriceMinor: number; baseMinor: number; fromBook: boolean; modifiers: PricedModifier[] } | { ok: false; error: PricingError } {
  const fromBook = input.bookPriceMinor !== null && input.bookPriceMinor !== undefined;
  const base = fromBook ? input.bookPriceMinor! : input.listPriceMinor;
  const groups = new Map(input.groups.filter((g) => g.active !== false).map((g) => [g.id, g]));
  const chosen = new Map<string, string[]>();
  for (const c of input.choices ?? []) {
    const g = groups.get(c.groupId);
    if (!g) return { ok: false, error: { code: 'MODIFIER_NOT_ON_PRODUCT', message: 'That option is not available for this product' } };
    if (chosen.has(c.groupId)) return { ok: false, error: { code: 'MODIFIER_GROUP_TWICE', message: `"${g.name}" was answered twice` } };
    const ids = [...new Set(c.optionIds ?? [])];
    chosen.set(c.groupId, ids);
  }
  const out: PricedModifier[] = [];
  for (const g of groups.values()) {
    const ids = chosen.get(g.id) ?? [];
    if (ids.length < g.minSelect) return { ok: false, error: { code: 'MODIFIER_REQUIRED', message: g.minSelect === 1 ? `Choose ${g.name}` : `Choose at least ${g.minSelect} for ${g.name}` } };
    if (ids.length > g.maxSelect) return { ok: false, error: { code: 'MODIFIER_TOO_MANY', message: `Choose at most ${g.maxSelect} for ${g.name}` } };
    for (const id of ids) {
      const o = g.options.find((x) => x.id === id && x.active !== false);
      if (!o) return { ok: false, error: { code: 'MODIFIER_OPTION_UNKNOWN', message: `An option of ${g.name} is no longer available` } };
      out.push({ groupId: g.id, groupName: g.name, optionId: o.id, name: o.name, priceDeltaMinor: o.priceDeltaMinor });
    }
  }
  const unit = base + out.reduce((n, m) => n + m.priceDeltaMinor, 0);
  if (unit < 0) return { ok: false, error: { code: 'PRICE_BELOW_ZERO', message: 'The options make the price negative' } };
  return { ok: true, unitPriceMinor: unit, baseMinor: base, fromBook, modifiers: out };
}

/** How a line's modifiers read on a receipt: "Latte (Large, + Oat milk, + Extra shot)". */
export const modifierSuffix = (mods: PricedModifier[]): string => (mods.length ? ` (${mods.map((m) => m.name).join(', ')})` : '');

/** Is a price book in force at `at`? */
export function bookActive(book: { active?: boolean; startsAt?: Date | string | null; endsAt?: Date | string | null } | null | undefined, at: Date): boolean {
  if (!book || book.active === false) return false;
  if (book.startsAt && new Date(book.startsAt) > at) return false;
  if (book.endsAt && new Date(book.endsAt) <= at) return false;
  return true;
}
