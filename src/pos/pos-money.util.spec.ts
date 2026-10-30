/* eslint-disable prettier/prettier */
import {
  allocateRefund, assertClientTotal, byTender, computeTotals, effectivePayments, exponentOf, fromMinor,
  partialRefundAmount, roundMoney, settlePayments, tenderNets, toMinor, PaymentLine,
} from './pos-money.util';

const code = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.getResponse?.().code ?? e.message; } return 'NO_ERROR'; };

describe('exponents', () => {
  it.each([['JPY', 0], ['PKR', 2], ['USD', 2], ['KWD', 3], ['BHD', 3], ['usd', 2], [undefined, 2], [null, 2]])('%s → %s decimals', (c, e) => {
    expect(exponentOf(c as any)).toBe(e);
  });
});

describe('roundMoney (half away from zero, float-noise proof)', () => {
  it('2 decimals', () => {
    expect(roundMoney(1.005, 2)).toBe(1.01);   // the classic 1.00499999… case
    expect(roundMoney(2.675, 2)).toBe(2.68);
    expect(roundMoney(0.1 + 0.2, 2)).toBe(0.3);
    expect(roundMoney(-1.005, 2)).toBe(-1.01);
  });
  it('0 decimals (JPY)', () => {
    expect(roundMoney(100.5, 0)).toBe(101);
    expect(roundMoney(100.49, 0)).toBe(100);
    expect(roundMoney(0.5, 0)).toBe(1);
  });
  it('3 decimals (KWD)', () => {
    expect(roundMoney(1.2345, 3)).toBe(1.235);
    expect(roundMoney(1.0005, 3)).toBe(1.001);
    expect(roundMoney(0.0004, 3)).toBe(0);
  });
  it('round trip minor units', () => {
    expect(toMinor(19.99, 2)).toBe(1999);
    expect(fromMinor(1999, 2)).toBe(19.99);
    expect(toMinor(1234, 0)).toBe(1234);
    expect(toMinor(12.345, 3)).toBe(12345);
  });
});

describe('computeTotals — rounding per exponent', () => {
  it('USD: line totals rounded, then summed, discount%, tax on the discounted base', () => {
    const t = computeTotals([{ price: 19.99, qty: 3 }, { price: 0.335, qty: 1 }], { exp: 2, discountType: 'percent', discountValue: 10, taxRate: 0.0825 });
    // lines: 59.97 and 0.34 (0.335 → 0.34) → subtotal 60.31; 10% = 6.031 → 6.03; taxable 54.28; tax 4.4781 → 4.48; total 58.76
    expect(t.lineTotals).toEqual([59.97, 0.34]);
    expect(t.subtotal).toBe(60.31);
    expect(t.discount).toBe(6.03);
    expect(t.tax).toBe(4.48);
    expect(t.total).toBe(58.76);
  });
  it('JPY (0 decimals): never produces fractional yen', () => {
    const t = computeTotals([{ price: 333, qty: 3 }, { price: 99, qty: 1 }], { exp: 0, discountType: 'percent', discountValue: 15, taxRate: 0.1 });
    // subtotal 1098; 15% = 164.7 → 165; taxable 933; tax 93.3 → 93; total 1026
    expect(t).toMatchObject({ subtotal: 1098, discount: 165, tax: 93, total: 1026 });
    for (const v of [t.subtotal, t.discount, t.tax, t.total]) expect(Number.isInteger(v)).toBe(true);
  });
  it('KWD (3 decimals): keeps the third decimal', () => {
    const t = computeTotals([{ price: 1.255, qty: 3 }], { exp: 3, discountType: 'amount', discountValue: 0.5, taxRate: 0.05 });
    // subtotal 3.765; discount 0.500; taxable 3.265; tax 0.16325 → 0.163; total 3.428
    expect(t).toMatchObject({ subtotal: 3.765, discount: 0.5, tax: 0.163, total: 3.428 });
  });
  it('PKR (2 decimals) flat discount, no tax', () => {
    const t = computeTotals([{ price: 1499.5, qty: 2 }], { exp: 2, discountType: 'amount', discountValue: 99.99, taxRate: 0 });
    expect(t).toMatchObject({ subtotal: 2999, discount: 99.99, tax: 0, total: 2899.01 });
  });
  it('the same inputs always give the same answer regardless of line order', () => {
    const a = computeTotals([{ price: 0.1, qty: 3 }, { price: 0.2, qty: 3 }], { exp: 2, taxRate: 0.07 });
    const b = computeTotals([{ price: 0.2, qty: 3 }, { price: 0.1, qty: 3 }], { exp: 2, taxRate: 0.07 });
    expect(a.total).toBe(b.total);
    expect(a.subtotal).toBe(0.9);
  });
  it('rejects (never clamps) a discount above the subtotal, and invalid discounts', () => {
    expect(code(() => computeTotals([{ price: 10, qty: 1 }], { exp: 2, discountType: 'amount', discountValue: 10.01, taxRate: 0 }))).toBe('DISCOUNT_EXCEEDS_SUBTOTAL');
    expect(code(() => computeTotals([{ price: 10, qty: 1 }], { exp: 2, discountType: 'percent', discountValue: 100.5, taxRate: 0 }))).toBe('INVALID_DISCOUNT');
    expect(code(() => computeTotals([{ price: 10, qty: 1 }], { exp: 2, discountValue: -1, taxRate: 0 }))).toBe('INVALID_DISCOUNT');
    expect(computeTotals([{ price: 10, qty: 1 }], { exp: 2, discountType: 'percent', discountValue: 100, taxRate: 0.2 }).total).toBe(0); // 100% off is fine
  });
});

describe('assertClientTotal (tampered / stale client totals)', () => {
  const t = computeTotals([{ price: 10, qty: 1 }], { exp: 2, taxRate: 0.1 }); // 11.00
  it('accepts an exact match, an absent total, and ±1 minor unit of rounding', () => {
    expect(() => assertClientTotal(11, t)).not.toThrow();
    expect(() => assertClientTotal(undefined, t)).not.toThrow();
    expect(() => assertClientTotal(11.01, t)).not.toThrow();
    expect(() => assertClientTotal(10.99, t)).not.toThrow();
  });
  it('rejects a tampered total with the server figures so the app can refresh', () => {
    try { assertClientTotal(1, t); throw new Error('should have thrown'); } catch (e: any) {
      expect(e.getResponse()).toMatchObject({ code: 'TOTAL_MISMATCH', expectedTotal: 11, clientTotal: 1, subtotal: 10, tax: 1 });
    }
    expect(code(() => assertClientTotal(11.02, t))).toBe('TOTAL_MISMATCH');
  });
  it('the tolerance is one MINOR unit of the currency (JPY: 1 yen, not 1 cent)', () => {
    const jpy = computeTotals([{ price: 1000, qty: 1 }], { exp: 0, taxRate: 0 });
    expect(() => assertClientTotal(1001, jpy)).not.toThrow();
    expect(code(() => assertClientTotal(1002, jpy))).toBe('TOTAL_MISMATCH');
  });
});

describe('settlePayments (split tender)', () => {
  const exp = 2;
  const M = (n: number) => toMinor(n, exp);

  it('legacy single cash payment, exact', () => {
    const r = settlePayments(M(25), exp, { paymentMethod: 'cash' });
    expect(r).toMatchObject({ method: 'cash', change: 0, lines: [{ method: 'cash', amount: 25, tendered: 25 }] });
  });
  it('legacy cash with tendered > total → change computed server-side', () => {
    const r = settlePayments(M(25), exp, { paymentMethod: 'cash', amountTendered: 40 });
    expect(r.change).toBe(15);
    expect(r.lines).toEqual([{ method: 'cash', amount: 25, tendered: 40, reference: null }]);
  });
  it('legacy card pays the total exactly and ignores any tendered figure', () => {
    const r = settlePayments(M(25), exp, { paymentMethod: 'card', amountTendered: 99, reference: 'AUTH1' });
    expect(r).toMatchObject({ method: 'card', change: 0, lines: [{ method: 'card', amount: 25, reference: 'AUTH1' }] });
  });
  it('split cash + card: applied amounts sum to the total; method is "split"', () => {
    const r = settlePayments(M(100), exp, { payments: [{ method: 'card', amount: 60, reference: 'AUTH-9' }, { method: 'cash', amount: 40 }] });
    expect(r.method).toBe('split');
    expect(r.change).toBe(0);
    expect(r.lines.reduce((s, l) => s + l.amount, 0)).toBe(100);
  });
  it('cash may exceed what is left after the card portion — the overage is change', () => {
    const r = settlePayments(M(100), exp, { payments: [{ method: 'card', amount: 60 }, { method: 'cash', amount: 50 }] });
    expect(r.change).toBe(10);
    expect(r.lines.find((l) => l.method === 'cash')).toMatchObject({ amount: 40, tendered: 50 });
  });
  it('multiple cash lines (notes + coins) are applied in order, change from the total overage', () => {
    const r = settlePayments(M(30), exp, { payments: [{ method: 'cash', amount: 20 }, { method: 'cash', amount: 20 }] });
    expect(r.change).toBe(10);
    expect(r.lines.map((l) => l.amount)).toEqual([20, 10]);
  });
  it('card/other can never exceed the total (no change from a card)', () => {
    expect(code(() => settlePayments(M(50), exp, { payments: [{ method: 'card', amount: 60 }] }))).toBe('PAYMENT_EXCEEDS_TOTAL');
    expect(code(() => settlePayments(M(50), exp, { payments: [{ method: 'card', amount: 30 }, { method: 'other', amount: 30 }] }))).toBe('PAYMENT_EXCEEDS_TOTAL');
  });
  it('rejects payments that do not cover the total, with the shortfall', () => {
    try { settlePayments(M(100), exp, { payments: [{ method: 'card', amount: 60 }, { method: 'cash', amount: 30 }] }); throw new Error('x'); } catch (e: any) {
      expect(e.getResponse()).toMatchObject({ code: 'PAYMENT_SHORT', shortBy: 10, total: 100 });
    }
    expect(code(() => settlePayments(M(100), exp, { payments: [{ method: 'card', amount: 99.99 }] }))).toBe('PAYMENT_SHORT');
  });
  it('rejects unknown methods, zero/negative lines and too many lines', () => {
    expect(code(() => settlePayments(M(10), exp, { payments: [{ method: 'bitcoin', amount: 10 }] }))).toBe('INVALID_PAYMENT_METHOD');
    expect(code(() => settlePayments(M(10), exp, { payments: [{ method: 'cash', amount: 0 }] }))).toBe('INVALID_PAYMENT_AMOUNT');
    expect(code(() => settlePayments(M(10), exp, { payments: [{ method: 'cash', amount: -5 }] }))).toBe('INVALID_PAYMENT_AMOUNT');
    expect(code(() => settlePayments(M(10), exp, { payments: Array.from({ length: 9 }, () => ({ method: 'cash', amount: 1 })) }))).toBe('TOO_MANY_PAYMENTS');
  });
  it('amounts are rounded to the currency exponent (JPY has no fractional yen)', () => {
    const r = settlePayments(toMinor(1000, 0), 0, { payments: [{ method: 'card', amount: 600.4 }, { method: 'cash', amount: 400 }] });
    expect(r.lines[0].amount).toBe(600);
    expect(r.lines.reduce((s, l) => s + l.amount, 0)).toBe(1000);
  });
  it('a zero-total sale (100% discount) settles with no money moving', () => {
    const r = settlePayments(0, exp, { paymentMethod: 'cash' });
    expect(r.change).toBe(0);
    expect(r.lines.reduce((s, l) => s + l.amount, 0)).toBe(0);
  });
  it('KWD 3-decimal split', () => {
    const r = settlePayments(toMinor(12.345, 3), 3, { payments: [{ method: 'card', amount: 10.001 }, { method: 'cash', amount: 2.344 }] });
    expect(r.lines.reduce((s, l) => s + toMinor(l.amount, 3), 0)).toBe(12345);
  });
});

describe('refund allocation against split tender (documented order: non-cash first, cash last)', () => {
  const exp = 2;
  const split: PaymentLine[] = [{ method: 'cash', amount: 40, tendered: 50 }, { method: 'card', amount: 60, reference: 'A' }]; // cash entered first
  const sumOf = (a: Array<{ method: string; amount: number }>) => Object.fromEntries(a.map((x) => [x.method, x.amount]));

  it('refunds the card first even though cash was entered first', () => {
    expect(sumOf(allocateRefund(split, 0, 25, exp))).toEqual({ card: 25 });
    expect(sumOf(allocateRefund(split, 0, 60, exp))).toEqual({ card: 60 });
  });
  it('spills into cash only after the card line is exhausted', () => {
    expect(sumOf(allocateRefund(split, 0, 70, exp))).toEqual({ card: 60, cash: 10 });
    expect(sumOf(allocateRefund(split, 0, 100, exp))).toEqual({ card: 60, cash: 40 });
  });
  it('is cumulative: later refunds continue where the earlier ones stopped', () => {
    expect(sumOf(allocateRefund(split, 25, 25, exp))).toEqual({ card: 25 });
    expect(sumOf(allocateRefund(split, 50, 25, exp))).toEqual({ card: 10, cash: 15 });
    expect(sumOf(allocateRefund(split, 75, 25, exp))).toEqual({ cash: 25 });
  });
  it('the allocations over any sequence of refunds add up to exactly what was refunded', () => {
    let done = 0; const tot: Record<string, number> = { cash: 0, card: 0 };
    for (const step of [13.37, 20.01, 33.33, 0.01, 33.28]) {
      for (const p of allocateRefund(split, done, step, exp)) tot[p.method] = Math.round((tot[p.method] + p.amount) * 100) / 100;
      done = Math.round((done + step) * 100) / 100;
    }
    expect(done).toBe(100);
    expect(tot).toEqual({ cash: 40, card: 60 });
  });
  it('a refund never exceeds what each tender took (cash change is NOT refundable)', () => {
    // cash tendered 50 but only 40 was applied: refunding 100 returns 40 cash, not 50
    expect(sumOf(allocateRefund(split, 0, 100, exp)).cash).toBe(40);
  });
  it('legacy single-payment sales (no payments array) allocate to their one method', () => {
    const legacy = effectivePayments({ paymentMethod: 'cash', total: 20 });
    expect(allocateRefund(legacy, 0, 5, exp)).toEqual([{ method: 'cash', amount: 5 }]);
    expect(effectivePayments({ paymentMethod: 'card', total: 20 })).toEqual([{ method: 'card', amount: 20 }]);
  });
});

describe('tenderNets — what the reports and the drawer count', () => {
  const sale = (over: any) => ({ payments: [{ method: 'cash', amount: 40 }, { method: 'card', amount: 60 }], total: 100, status: 'completed', refundedAmount: 0, ...over });
  it('un-refunded: the full amount per tender', () => {
    expect(tenderNets(sale({}), 2)).toEqual({ cash: 40, card: 60, other: 0 });
  });
  it('a partial refund reduces the right tender (card first), leaving cash untouched until card is gone', () => {
    expect(tenderNets(sale({ status: 'partially_refunded', refundedAmount: 25 }), 2)).toEqual({ cash: 40, card: 35, other: 0 });
    expect(tenderNets(sale({ status: 'partially_refunded', refundedAmount: 70 }), 2)).toEqual({ cash: 30, card: 0, other: 0 });
  });
  it('a CASH-only partial refund lowers the cash the drawer should hold (expected-cash fix)', () => {
    expect(tenderNets({ paymentMethod: 'cash', total: 50, status: 'partially_refunded', refundedAmount: 12.5 }, 2)).toEqual({ cash: 37.5, card: 0, other: 0 });
  });
  it('voided / fully refunded sales net to zero', () => {
    expect(tenderNets(sale({ status: 'voided' }), 2)).toEqual({ cash: 0, card: 0, other: 0 });
    expect(tenderNets(sale({ status: 'refunded', refundedAmount: 100 }), 2)).toEqual({ cash: 0, card: 0, other: 0 });
  });
  it('byTender folds a breakdown into a record', () => {
    expect(byTender([{ method: 'card', amount: 5 }, { method: 'card', amount: 2 }, { method: 'cash', amount: 1 }])).toEqual({ cash: 1, card: 7, other: 0 });
  });
});

describe('partialRefundAmount — pro-rated tax & discount, exact remainder on the last refund', () => {
  // 3 × 10.00, 10% off, 8% tax → subtotal 30, discount 3, taxable 27, tax 2.16, total 29.16
  const sale = { subtotal: 30, total: 29.16, refundedAmount: 0 };
  it('refunding one of three units returns its share of what was PAID, not the sticker price', () => {
    expect(partialRefundAmount(sale, [{ price: 10, qty: 1 }], 2, false)).toBe(9.72); // 29.16 / 3
  });
  it('the last refund returns the exact remainder so rounding never leaves a stray cent', () => {
    let refunded = 0;
    const a = partialRefundAmount({ ...sale, refundedAmount: refunded }, [{ price: 10, qty: 1 }], 2, false); refunded += a;
    const b = partialRefundAmount({ ...sale, refundedAmount: refunded }, [{ price: 10, qty: 1 }], 2, false); refunded += b;
    const c = partialRefundAmount({ ...sale, refundedAmount: Math.round(refunded * 100) / 100 }, [{ price: 10, qty: 1 }], 2, true);
    expect(Math.round((a + b + c) * 100) / 100).toBe(29.16);
  });
  it('never refunds more than is left', () => {
    expect(partialRefundAmount({ ...sale, refundedAmount: 25 }, [{ price: 10, qty: 3 }], 2, false)).toBe(4.16);
  });
  it('works in a 0-decimal currency', () => {
    expect(partialRefundAmount({ subtotal: 1000, total: 1100, refundedAmount: 0 }, [{ price: 500, qty: 1 }], 0, false)).toBe(550);
  });
  it('an empty-subtotal sale refunds nothing rather than dividing by zero', () => {
    expect(partialRefundAmount({ subtotal: 0, total: 0 }, [{ price: 0, qty: 1 }], 2, false)).toBe(0);
  });
});
