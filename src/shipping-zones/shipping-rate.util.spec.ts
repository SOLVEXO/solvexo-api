import { resolveZoneShippingPrice, validateRateTiers } from './shipping-rate.util';

describe('resolveZoneShippingPrice', () => {
  const cart = { subtotal: 100, weightKg: 2.5 };

  it('flat zone returns shippingPrice', () => {
    expect(resolveZoneShippingPrice({ rateType: 'flat', shippingPrice: 7 }, cart)).toBe(7);
    expect(resolveZoneShippingPrice({ shippingPrice: 9 }, cart)).toBe(9);
  });

  it('pickup is always free', () => {
    expect(resolveZoneShippingPrice({ zoneType: 'pickup', shippingPrice: 50 }, cart)).toBe(0);
  });

  it('free-shipping threshold wins once reached', () => {
    const z = { rateType: 'flat', shippingPrice: 10, freeShippingThreshold: 100 };
    expect(resolveZoneShippingPrice(z, { subtotal: 99.99, weightKg: 1 })).toBe(10);
    expect(resolveZoneShippingPrice(z, cart)).toBe(0);
  });

  it('weight tiers pick the matching band, open-ended last tier', () => {
    const z = { rateType: 'weight', rateTiers: [{ min: 0, max: 1, price: 5 }, { min: 1.01, max: 3, price: 8 }, { min: 3.01, max: null, price: 20 }] };
    expect(resolveZoneShippingPrice(z, { subtotal: 1, weightKg: 0.5 })).toBe(5);
    expect(resolveZoneShippingPrice(z, cart)).toBe(8);
    expect(resolveZoneShippingPrice(z, { subtotal: 1, weightKg: 50 })).toBe(20);
  });

  it('price tiers use the subtotal; no matching tier = not offered', () => {
    const z = { rateType: 'price', rateTiers: [{ min: 0, max: 50, price: 6 }, { min: 50.01, max: 80, price: 3 }] };
    expect(resolveZoneShippingPrice(z, { subtotal: 20, weightKg: 1 })).toBe(6);
    expect(resolveZoneShippingPrice(z, cart)).toBeNull();
  });
});

describe('validateRateTiers', () => {
  it('ignores flat zones', () => {
    expect(validateRateTiers('flat', undefined)).toBeNull();
  });
  it('requires tiers for weight/price', () => {
    expect(validateRateTiers('weight', [])).toMatch(/at least one/);
  });
  it('rejects overlap, min>=max and negatives', () => {
    expect(validateRateTiers('price', [{ min: 0, max: 10, price: 1 }, { min: 5, max: 20, price: 2 }])).toMatch(/overlap/);
    expect(validateRateTiers('price', [{ min: 5, max: 5, price: 1 }])).toMatch(/greater/);
    expect(validateRateTiers('price', [{ min: 0, max: 5, price: -1 }])).toMatch(/negative/);
  });
  it('rejects an open-ended tier that is not last', () => {
    expect(validateRateTiers('weight', [{ min: 0, max: null, price: 1 }, { min: 5, max: 9, price: 2 }])).toMatch(/overlap/);
  });
  it('accepts a clean set', () => {
    expect(validateRateTiers('weight', [{ min: 0, max: 1, price: 1 }, { min: 1.01, max: null, price: 2 }])).toBeNull();
  });
});
