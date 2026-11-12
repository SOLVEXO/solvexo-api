/* eslint-disable prettier/prettier */
import { PlatformPlanCatalogService } from './platform-plan-catalog.service';
import { LAUNCH_DISCOUNT, launchPriceFor, validatePlanPricing } from './platform-plan.catalog';

/** A Mongoose-like plan document: plain fields plus a save() spy. */
function planDoc(fields: Record<string, any>): Record<string, any> & { save: jest.Mock } {
  return { isFree: false, isCustomPricing: false, isDelete: false, launchDiscountApplied: false,
    stripeMonthlyPriceId: 'price_m', stripeYearlyPriceId: 'price_y', stripeIntroCouponId: 'coupon',
    introOfferEnabled: true, introPriceUSD: 1, introDurationCycles: 3, ...fields, save: jest.fn().mockResolvedValue(undefined) };
}

function serviceWith(docs: any[]) {
  const planModel = { find: jest.fn().mockResolvedValue(docs.filter(d => !d.launchDiscountApplied)) };
  return new PlatformPlanCatalogService({ repositories: { platformPlanModel: planModel } } as any);
}

describe('launch discount', () => {
  it('cuts 40% and rounds down to whole dollars, so the cut is never smaller than 40%', () => {
    expect(LAUNCH_DISCOUNT).toBe(0.4);
    expect([10, 49, 99, 299].map(launchPriceFor)).toEqual([6, 29, 59, 179]);
    expect([100, 470, 950, 2870].map(launchPriceFor)).toEqual([60, 282, 570, 1722]);
  });

  it('turns the current price into the crossed-out "was" price and charges the lower one', async () => {
    const grow = planDoc({ key: 'grow', name: 'Grow', monthlyPriceUSD: 49, yearlyPriceUSD: 470 });
    await serviceWith([grow]).applyLaunchDiscount();
    expect(grow).toMatchObject({
      monthlyPriceUSD: 29, yearlyPriceUSD: 282, compareAtMonthlyPriceUSD: 49, compareAtYearlyPriceUSD: 470,
      launchDiscountApplied: true, introPriceUSD: 1, introDurationCycles: 3,
      // Stripe prices/coupons mirror the old amounts and must be recreated.
      stripeMonthlyPriceId: null, stripeYearlyPriceId: null, stripeIntroCouponId: null,
    });
    expect(grow.save).toHaveBeenCalledTimes(1);
  });

  it('runs once: a plan already discounted (or re-priced by an admin since) is left alone', async () => {
    const done = planDoc({ key: 'basic', name: 'Basic', monthlyPriceUSD: 8, yearlyPriceUSD: 80, launchDiscountApplied: true });
    await serviceWith([done]).applyLaunchDiscount();
    expect(done.monthlyPriceUSD).toBe(8);
    expect(done.save).not.toHaveBeenCalled();
  });

  it('marks custom-priced plans as handled without touching them', async () => {
    const custom = planDoc({ key: 'enterprise', name: 'Enterprise', isCustomPricing: true, monthlyPriceUSD: null, yearlyPriceUSD: null });
    await serviceWith([custom]).applyLaunchDiscount();
    expect(custom).toMatchObject({ monthlyPriceUSD: null, launchDiscountApplied: true });
    expect(custom.compareAtMonthlyPriceUSD).toBeUndefined();
  });

  it('skips a plan whose discounted price would break the pricing rules, and tries again next boot', async () => {
    // A $6 intro is not below the $6 launch price.
    const odd = planDoc({ key: 'basic', name: 'Basic', monthlyPriceUSD: 10, yearlyPriceUSD: 100, introPriceUSD: 6 });
    await serviceWith([odd]).applyLaunchDiscount();
    expect(odd).toMatchObject({ monthlyPriceUSD: 10, launchDiscountApplied: false });
    expect(odd.save).not.toHaveBeenCalled();
  });

  it('requires a "was" price to be higher than the real price', () => {
    const base = { monthlyPriceUSD: 29, yearlyPriceUSD: 282 };
    expect(validatePlanPricing({ ...base, compareAtMonthlyPriceUSD: 49, compareAtYearlyPriceUSD: 470 })).toEqual([]);
    expect(validatePlanPricing({ ...base, compareAtMonthlyPriceUSD: 29 })).toEqual(['The "was" monthly price must be higher than the monthly price.']);
    expect(validatePlanPricing({ ...base, compareAtYearlyPriceUSD: 200 })).toEqual(['The "was" yearly price must be higher than the yearly price.']);
  });
});
