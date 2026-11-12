/* eslint-disable prettier/prettier */
import { allocateLargestRemainder, cumulativeShare, daysBetween, formatDocNumber, lineBreakdown, returnApprovalReasons, returnLineAmounts } from './pos-documents.util';
import { computeTotals } from './pos-money.util';

describe('allocateLargestRemainder', () => {
  it('always sums to the total', () => {
    for (const [t, w] of [[100, [1, 1, 1]], [7, [3, 3, 3]], [1, [5, 5]], [0, [1, 2]], [999, [333, 333, 333, 1]]] as Array<[number, number[]]>) {
      expect(allocateLargestRemainder(t, w).reduce((s, x) => s + x, 0)).toBe(t);
    }
  });
  it('gives the extra unit to the largest remainder, ties to the first', () => {
    expect(allocateLargestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateLargestRemainder(2, [1, 1, 1])).toEqual([1, 1, 0]);
  });
  it('a zero-weight line gets nothing', () => {
    expect(allocateLargestRemainder(10, [0, 5, 5])).toEqual([0, 5, 5]);
  });
});

describe.each([[0, 'JPY'], [2, 'PKR'], [3, 'KWD']])('line breakdown + returns, exponent %i (%s)', (exp) => {
  const unit = 10 ** exp;
  // three lines, a 10% discount and a 17% tax with an exempt middle line
  const grosses = [Math.round(10.37 * unit) * 3, Math.round(4.99 * unit) * 2, Math.round(7.13 * unit)];
  const sub = grosses.reduce((s, x) => s + x, 0);
  const lines = [{ price: grosses[0] / 3 / unit, qty: 3, taxable: true }, { price: grosses[1] / 2 / unit, qty: 2, taxable: false }, { price: grosses[2] / unit, qty: 1, taxable: true }];
  const t = computeTotals(lines, { exp, discountType: 'percent', discountValue: 10, taxRate: 0.17 });
  const bd = lineBreakdown(t.lineTotalsMinor.map((g, i) => ({ grossMinor: g, taxable: lines[i].taxable })), t.minor.discount, t.minor.tax);

  it('the lines add up to the sale exactly (gross, discount, tax, total)', () => {
    expect(bd.reduce((s, l) => s + l.grossMinor, 0)).toBe(t.minor.subtotal);
    expect(bd.reduce((s, l) => s + l.discountMinor, 0)).toBe(t.minor.discount);
    expect(bd.reduce((s, l) => s + l.taxMinor, 0)).toBe(t.minor.tax);
    expect(bd.reduce((s, l) => s + l.totalMinor, 0)).toBe(t.minor.total);
    expect(sub).toBe(t.minor.subtotal);
  });
  it('an exempt line carries no tax', () => {
    expect(bd[1].taxMinor).toBe(0);
  });
  it('returning a line one unit at a time credits exactly what the line was charged', () => {
    const sold = lines[0].qty;
    let acc = 0;
    for (let r = 0; r < sold; r++) acc += returnLineAmounts(bd[0], sold, r, 1).totalMinor;
    expect(acc).toBe(bd[0].totalMinor);
  });
  it('returning in any order of chunks gives the same total, and each credit is net + tax', () => {
    const sold = lines[0].qty;
    const oneGo = returnLineAmounts(bd[0], sold, 0, sold);
    expect(oneGo).toEqual(bd[0]);
    const a = returnLineAmounts(bd[0], sold, 0, 2);
    const b = returnLineAmounts(bd[0], sold, 2, 1);
    expect(a.totalMinor + b.totalMinor).toBe(bd[0].totalMinor);
    expect(a.netMinor + a.taxMinor).toBe(a.totalMinor);
    expect(a.discountMinor + b.discountMinor).toBe(bd[0].discountMinor);
    expect(a.taxMinor + b.taxMinor).toBe(bd[0].taxMinor);
  });
});

describe('cumulativeShare', () => {
  it('is monotone and ends exactly at the total', () => {
    let prev = 0;
    for (let n = 0; n <= 7; n++) { const s = cumulativeShare(1001, 7, n); expect(s).toBeGreaterThanOrEqual(prev); prev = s; }
    expect(cumulativeShare(1001, 7, 7)).toBe(1001);
  });
});

describe('document numbers and approval rules', () => {
  it('formats', () => expect(formatDocNumber('INV', 42)).toBe('INV-000042'));
  it('whole days', () => expect(daysBetween(new Date('2026-01-01T10:00:00Z'), new Date('2026-01-04T09:00:00Z'))).toBe(2));
  const base = { amountMinor: 1000, aboveMinor: 5000 as number | null, daysSinceSale: 2, afterDays: 7 as number | null, receiptPresented: true, cashierReturnsEnabled: true };
  it('a cashier may return within every limit', () => expect(returnApprovalReasons(base)).toEqual([]));
  it('each limit is reported', () => {
    expect(returnApprovalReasons({ ...base, amountMinor: 6000 })).toEqual(['amount_above_limit']);
    expect(returnApprovalReasons({ ...base, daysSinceSale: 9 })).toEqual(['too_many_days_since_sale']);
    expect(returnApprovalReasons({ ...base, receiptPresented: false })).toEqual(['no_original_receipt']);
    expect(returnApprovalReasons({ ...base, cashierReturnsEnabled: false })).toContain('store_requires_manager');
  });
  it('null limits mean "no limit"', () => expect(returnApprovalReasons({ ...base, aboveMinor: null, afterDays: null, amountMinor: 1e9, daysSinceSale: 999 })).toEqual([]));
});
