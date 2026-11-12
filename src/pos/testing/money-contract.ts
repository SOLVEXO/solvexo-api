/* eslint-disable prettier/prettier */
/**
 * The money contract of a POS response (G3 fix 1): wherever a response carries an amount in minor units (a key ending in `Minor`), the response must say, at that
 * object or any ancestor, which CURRENCY (`currency`, a 3-letter code) and which EXPONENT (`currencyExponent`, an integer) the amount is in — the app formats with those,
 * never with a configured fallback. Returns the paths that break it; a test asserts the list is empty for every G3 response.
 */
export function moneyContractViolations(json: any): string[] {
  const out: string[] = [];
  const walk = (v: any, path: string, ctx: { cur: boolean; exp: boolean }) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`, ctx));
    if (!v || typeof v !== 'object' || v instanceof Date) return;
    const here = {
      cur: ctx.cur || (typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency)),
      exp: ctx.exp || (typeof v.currencyExponent === 'number' && Number.isInteger(v.currencyExponent) && v.currencyExponent >= 0 && v.currencyExponent <= 4),
    };
    for (const [k, x] of Object.entries(v)) {
      if (/Minor$/.test(k) && x !== null && typeof x === 'number' && !(here.cur && here.exp)) out.push(`${path}.${k}`);
      else walk(x, `${path}.${k}`, here);
    }
  };
  walk(JSON.parse(JSON.stringify(json)), '$', { cur: false, exp: false });
  return out;
}
