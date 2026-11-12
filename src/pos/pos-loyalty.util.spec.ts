import { earnPoints, pointsToRestore, pointsToReverse, redeemValueMinor, tierFor } from './pos-loyalty.util';

describe('loyalty maths (integers; identical across currency exponents)', () => {
  // the same shop rule written for each currency: "1 point per 100.00 spent" and "1 point is worth 1.00"
  const cases: Array<[string, number, number, number, number]> = [
    ['JPY (exp 0)', 100, 1, 12_345, 123],      // earn per 100 yen; 12,345 yen → 123 points
    ['USD (exp 2)', 10_000, 100, 1_234_567, 123], // earn per 100.00; 12,345.67 → 123
    ['KWD (exp 3)', 100_000, 1_000, 12_345_678, 123],
  ];
  for (const [name, per, valueOfPoint, spend, expected] of cases) {
    it(`${name}: floor(spend / rate) = ${expected}; a point is worth ${valueOfPoint} minor units`, () => {
      expect(earnPoints(spend, per)).toBe(expected);
      expect(earnPoints(per - 1, per)).toBe(0);       // one minor unit short of a point earns none
      expect(earnPoints(per, per)).toBe(1);
      expect(redeemValueMinor(expected, valueOfPoint)).toBe(expected * valueOfPoint);
    });
  }
  it('no rate / zero or negative spend earns nothing; junk never produces NaN', () => {
    expect([earnPoints(5000, null), earnPoints(5000, 0), earnPoints(0, 100), earnPoints(-5, 100), redeemValueMinor(10, null), redeemValueMinor(-1, 5)]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('reversal is cumulative and exact: any way of returning a sale reverses EXACTLY the points earned, in total, never more', () => {
    const earned = 7, net = 1000;
    for (const chunks of [[250, 250, 250, 250], [1, 999], [333, 333, 334], [500, 500], [1000], [10, 20, 970], [999, 1]]) {
      let returned = 0, reversed = 0;
      for (const c of chunks) { returned += c; reversed += pointsToReverse(earned, net, returned, reversed); }
      expect([chunks.join('+'), reversed]).toEqual([chunks.join('+'), earned]);
    }
    expect(pointsToReverse(7, 1000, 500, 0)).toBe(4); // half of 7, half-up
    expect(pointsToReverse(7, 1000, 1500, 0)).toBe(7); // never more than earned
    expect(pointsToReverse(0, 1000, 500, 0)).toBe(0);
  });

  it('redeemed points come back in proportion to the money returned; a full return restores them all', () => {
    let restored = 0;
    for (const returned of [2500, 5000, 10000]) restored += pointsToRestore(40, 10000, returned, restored);
    expect(restored).toBe(40);
    expect(pointsToRestore(40, 10000, 2500, 0)).toBe(10);
  });

  it('tiers: the highest tier whose threshold is met', () => {
    const tiers = [{ name: 'Bronze', minPoints: 0 }, { name: 'Silver', minPoints: 500 }, { name: 'Gold', minPoints: 2000 }];
    expect([tierFor(10, tiers), tierFor(500, tiers), tierFor(5000, tiers), tierFor(10, [])]).toEqual(['Bronze', 'Silver', 'Gold', null]);
  });
});
