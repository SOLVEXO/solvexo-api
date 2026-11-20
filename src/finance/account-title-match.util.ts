/* eslint-disable prettier/prettier */
// Pure "does this bank account title belong to the seller?" check. Soft by design: a mismatch only flags the payout method
// for an admin to look at, it never blocks the seller. It compares the account holder with every name Solvexo has verified or
// been given for the store: the legal business name, the authorized contact and the account owner. Any one of them matching is enough.

/** Words that carry no identity: titles and company suffixes. */
const NOISE = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'm', 's', 'ms.', 'm/s', 'pvt', 'private', 'ltd', 'limited', 'llc', 'inc', 'co', 'company', 'corp', 'smc', 'the',
]);

export function nameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  return String(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && !NOISE.has(t));
}

/** Same person / business? Order, case, punctuation and titles do not matter. One-word names match when that word is shared. */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  const setB = new Set(tb);
  const shared = new Set(ta.filter((t) => setB.has(t))).size;
  if (shared === 0) return false;
  const smaller = Math.min(new Set(ta).size, setB.size);
  if (smaller === 1) return true;
  return shared >= 2 && shared / smaller >= 0.6;
}

export interface TitleCheck { flagged: boolean; note: string | null; comparedWith: string[] }

/** `accountHolder` against all known names. Nothing to compare with => not flagged (we cannot say it is wrong). */
export function checkAccountTitle(accountHolder: string | null | undefined, knownNames: (string | null | undefined)[]): TitleCheck {
  const names = [...new Set(knownNames.map((n) => (n ?? '').trim()).filter(Boolean))];
  if (!accountHolder || !accountHolder.trim() || !names.length) return { flagged: false, note: null, comparedWith: names };
  if (names.some((n) => namesMatch(accountHolder, n))) return { flagged: false, note: null, comparedWith: names };
  return {
    flagged: true,
    note: `Account holder "${accountHolder.trim()}" does not match ${names.map((n) => `"${n}"`).join(', ')}: flagged for admin review, not blocked.`,
    comparedWith: names,
  };
}
