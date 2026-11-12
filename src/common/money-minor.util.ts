import { getCurrencyDecimals } from './currency-metadata.const';

/**
 * Money in integer MINOR units (cents, paisa, fils, yen). ONE conversion for the whole backend — the bodies below are the ones
 * `pos/pos-money.util.ts` has always used (G1b moved them here unchanged so the parity with every stored sale is preserved).
 *
 * THE EXPONENT IS THE ISO-4217 ONE, always. PKR = 2. The storefront shows PKR with 0 decimals (`displayDecimals` in
 * markets/market-price.util.ts, `ExchangeRateService.roundForCurrency`) — that is a DISPLAY setting and must never be used to
 * convert money to minor units. `isoExponent` reads only the ISO table; a test pins PKR → 2 against the storefront's 0.
 */
export const isoExponent = (currency: string | null | undefined): number => getCurrencyDecimals((currency || 'USD').toUpperCase());

/** Largest amount a JS number (and a Dart int on the app) represents exactly: 2^53 − 1 minor units. */
export const MAX_MINOR = Number.MAX_SAFE_INTEGER;

/** Round half away from zero to `exp` decimals, immune to binary-float noise (1.005 → 1.01 at 2dp). */
export function roundMoney(n: number, exp: number): number {
  return fromMinor(toMinor(n, exp), exp);
}

/** Major units → integer minor units. */
export function toMinor(n: number, exp: number): number {
  const f = 10 ** exp;
  const scaled = Number((Math.abs(Number(n) || 0) * f).toPrecision(15));
  return Math.sign(n || 0) * Math.round(scaled);
}

export function fromMinor(m: number, exp: number): number {
  return Number((m / 10 ** exp).toFixed(exp));
}

/** True for a value a minor-unit field may hold: a safe integer (no fraction, no NaN/Infinity, |x| ≤ 2^53 − 1). */
export const isSafeMinor = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

export function assertSafeMinor(v: unknown, field = 'amount'): number {
  if (!isSafeMinor(v)) throw new RangeError(`${field} must be an integer number of minor units no larger than 2^53-1 (got ${String(v)})`);
  return v;
}

export interface MinorMismatch { path: string; major: number | null; minor: number | null; expectedMinor: number | null }

/**
 * The consistency checker's pure core (G1b step b): for every `[majorKey, minorKey]` pair, `minor` must equal `toMinor(major)`.
 * A missing PAIR is not a mismatch (legacy rows have no minor yet — the backfill's job); a minor present WITHOUT its major, a
 * major present with a DIFFERENT minor, or a non-integer minor, is. Array fields use `items[].priceMinor` style paths.
 */
export function checkMinorPairs(doc: any, pairs: Array<[string, string]>, exp: number): MinorMismatch[] {
  const out: MinorMismatch[] = [];
  const walk = (obj: any, majorPath: string[], minorPath: string[], label: string) => {
    if (obj == null) return;
    const [head, ...rest] = majorPath;
    const [mHead, ...mRest] = minorPath;
    if (head.endsWith('[]')) {
      const arr = obj[head.slice(0, -2)];
      if (!Array.isArray(arr)) return;
      arr.forEach((el, i) => walk(el, rest, mRest, `${label}${head.slice(0, -2)}[${i}].`));
      return;
    }
    if (rest.length) return walk(obj[head], rest, mRest, `${label}${head}.`);
    const major = obj[head];
    const minor = obj[mHead];
    if ((minor === undefined || minor === null) && (major === undefined || major === null)) return;
    if (minor === undefined || minor === null) return; // legacy row: no minor yet
    const m = typeof minor === 'object' && typeof (minor as any).toNumber === 'function' ? (minor as any).toNumber() : minor;
    if (major === undefined || major === null) { out.push({ path: label + mHead, major: null, minor: m, expectedMinor: null }); return; }
    const expected = toMinor(major, exp);
    if (!isSafeMinor(m) || m !== expected) out.push({ path: label + mHead, major, minor: isSafeMinor(m) ? m : null, expectedMinor: expected });
  };
  for (const [maj, min] of pairs) walk(doc, maj.split('.'), min.split('.'), '');
  return out;
}
