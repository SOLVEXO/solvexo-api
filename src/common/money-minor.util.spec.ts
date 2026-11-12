import { assertSafeMinor, checkMinorPairs, fromMinor, isoExponent, isSafeMinor, MAX_MINOR, roundMoney, toMinor } from './money-minor.util';
import { exponentOf } from '../pos/pos-money.util';
import { displayDecimals } from '../markets/market-price.util';

describe('money-minor conversion', () => {
  it.each([
    // [major, exp, minor]
    [0, 2, 0], [19.99, 2, 1999], [0.1 + 0.2, 2, 30], [1.005, 2, 101], [-2.5, 2, -250], [1234567.89, 2, 123456789],
    [500, 0, 500], [499.5, 0, 500], [-0.5, 0, -1], [12345, 0, 12345],
    [1.25, 3, 1250], [0.001, 3, 1], [-7.125, 3, -7125], [3.3000000000000007, 2, 330],
  ])('toMinor(%p, exp %p) = %p and fromMinor round-trips on the grid', (major, exp, minor) => {
    expect(toMinor(major, exp)).toBe(minor);
    expect(toMinor(fromMinor(minor, exp), exp)).toBe(minor);
  });

  it('roundMoney is exactly fromMinor(toMinor(x))', () => {
    for (const [x, e] of [[1.005, 2], [2.675, 2], [0.5, 0], [1.0005, 3]] as const) expect(roundMoney(x, e)).toBe(fromMinor(toMinor(x, e), e));
  });

  it('the shift-counter drift case: 2.2 + 1.1 = 3.3000000000000007 in major, but the minor counter is the exact integer 330', () => {
    const drifted = 2.2 + 1.1;
    expect(drifted).not.toBe(3.3);
    expect(toMinor(drifted, 2)).toBe(330);
    expect(toMinor(2.2, 2) + toMinor(1.1, 2)).toBe(330);
    // the checker accepts it: a major drift of 1e-16 is NOT a mismatch against the exact minor
    expect(checkMinorPairs({ cardSales: drifted, cardSalesMinor: 330 }, [['cardSales', 'cardSalesMinor']], 2)).toEqual([]);
  });

  it('MAX_MINOR is 2^53 - 1 and only safe integers are valid minor values', () => {
    expect(MAX_MINOR).toBe(9007199254740991);
    for (const ok of [0, 1, -1, 123456789, MAX_MINOR, -MAX_MINOR]) expect(isSafeMinor(ok)).toBe(true);
    for (const bad of [1.5, NaN, Infinity, -Infinity, MAX_MINOR + 1, '12', null, undefined]) expect(isSafeMinor(bad as any)).toBe(false);
    expect(() => assertSafeMinor(0.1, 'x')).toThrow(RangeError);
    expect(assertSafeMinor(42)).toBe(42);
  });
});

describe('the exponent is the ISO-4217 one — never the storefront display setting', () => {
  it('PKR converts with 2 decimals even though the storefront DISPLAYS PKR with 0', () => {
    expect(displayDecimals('PKR')).toBe(0); // the storefront display setting
    expect(isoExponent('PKR')).toBe(2); // what money conversion uses
    expect(exponentOf('PKR')).toBe(2); // the POS wrapper reads the ISO table too
    expect(exponentOf('pkr')).toBe(2);
    expect(toMinor(12.5, exponentOf('PKR'))).toBe(1250); // 12.50 rupees = 1250 paisa
    expect(toMinor(12.5, displayDecimals('PKR'))).toBe(13); // proof that using the display setting would corrupt money
  });
  it('the ISO table: JPY 0, USD 2, KWD 3, unknown → 2, null → USD', () => {
    expect([isoExponent('JPY'), isoExponent('USD'), isoExponent('KWD'), isoExponent('ZZZ'), isoExponent(null)]).toEqual([0, 2, 3, 2, 2]);
  });
});

describe('consistency checker (pure core)', () => {
  const pairs: Array<[string, string]> = [['total', 'totalMinor'], ['items[].price', 'items[].priceMinor'], ['payments[].amount', 'payments[].amountMinor']];
  it('passes consistent documents (and legacy documents that have no minor yet)', () => {
    expect(checkMinorPairs({ total: 19.99, totalMinor: 1999, items: [{ price: 5, priceMinor: 500 }], payments: [{ amount: 19.99, amountMinor: 1999 }] }, pairs, 2)).toEqual([]);
    expect(checkMinorPairs({ total: 19.99, items: [{ price: 5 }] }, pairs, 2)).toEqual([]);
  });
  it('CATCHES an injected mismatch (top level and inside arrays), a non-integer minor and an orphan minor', () => {
    const r = checkMinorPairs({ total: 19.99, totalMinor: 2000, items: [{ price: 5, priceMinor: 500 }, { price: 7, priceMinor: 701 }], payments: [{ amountMinor: 5 }] }, pairs, 2);
    expect(r.map((m) => m.path)).toEqual(['totalMinor', 'items[1].priceMinor', 'payments[0].amountMinor']);
    expect(r[0]).toMatchObject({ major: 19.99, minor: 2000, expectedMinor: 1999 });
    expect(r[2]).toMatchObject({ major: null, minor: 5 });
    expect(checkMinorPairs({ total: 1, totalMinor: 100.5 }, [['total', 'totalMinor']], 2)).toHaveLength(1);
  });
  it('honours the exponent (0 and 3)', () => {
    expect(checkMinorPairs({ total: 500, totalMinor: 500 }, [['total', 'totalMinor']], 0)).toEqual([]);
    expect(checkMinorPairs({ total: 1.25, totalMinor: 1250 }, [['total', 'totalMinor']], 3)).toEqual([]);
    expect(checkMinorPairs({ total: 1.25, totalMinor: 125 }, [['total', 'totalMinor']], 3)).toHaveLength(1);
  });
});
