/* eslint-disable prettier/prettier */
import { PackItem, ShippingPackage, packItems } from './shipping-math.util';

const pkg = (id: string, l: number, w: number, h: number, extra: Partial<ShippingPackage> = {}): ShippingPackage => ({
  id, name: id, length: l, width: w, height: h, unit: 'cm', emptyWeight: 0.1, isDefault: false, ...extra,
});
const item = (l: number | null, w: number | null, h: number | null, weightKg = 0.5, quantity = 1): PackItem => ({ lengthCm: l, widthCm: w, heightCm: h, weightKg, quantity });

describe('packItems (Shopify-style packing by item dimensions)', () => {
  const small = pkg('small', 20, 15, 10);
  const medium = pkg('medium', 40, 30, 20, { isDefault: true });
  const large = pkg('large', 60, 40, 40);

  it('no saved packages -> one legacy fallback parcel with the total goods weight', () => {
    expect(packItems([item(10, 10, 10, 1, 2)], [])).toEqual([{ pkg: null, goodsWeightKg: 2 }]);
  });

  it('picks the SMALLEST saved package that holds everything', () => {
    const out = packItems([item(18, 12, 8, 0.4)], [large, medium, small]);
    expect(out).toHaveLength(1);
    expect(out[0].pkg?.id).toBe('small');
    expect(out[0].goodsWeightKg).toBeCloseTo(0.4);
  });

  it('combined volume decides: two items that do not fit the small box together go to the next one', () => {
    const out = packItems([item(18, 12, 8, 0.4, 2)], [small, medium, large]);
    expect(out).toHaveLength(1);
    expect(out[0].pkg?.id).toBe('medium');
    expect(out[0].goodsWeightKg).toBeCloseTo(0.8);
  });

  it('rotation is allowed (dimensions compared sorted)', () => {
    expect(packItems([item(10, 15, 20)], [small, medium])[0].pkg?.id).toBe('small');
  });

  it('inch packages are converted to cm', () => {
    const inch = pkg('inch', 8, 6, 4, { unit: 'in' }); // 20.32 x 15.24 x 10.16 cm
    expect(packItems([item(20, 15, 10)], [inch])[0].pkg?.id).toBe('inch');
  });

  it('items without dimensions add weight only; all undimensioned -> default package', () => {
    expect(packItems([item(null, null, null, 1.5)], [small, medium])).toEqual([{ pkg: medium, goodsWeightKg: 1.5 }]);
    const mixed = packItems([item(18, 12, 8, 0.4), item(null, null, null, 1)], [small, medium]);
    expect(mixed[0].pkg?.id).toBe('small');
    expect(mixed[0].goodsWeightKg).toBeCloseTo(1.4);
  });

  it('splits into several boxes of the default package when no single package holds the cart', () => {
    // each 30x25x15 item is 11250 cm3; the 40x30x20 box is 24000 -> 2 per box, 5 items -> 3 boxes
    const out = packItems([item(30, 25, 15, 1, 5)], [pkg('only', 40, 30, 20, { isDefault: true })]);
    expect(out).toHaveLength(3);
    expect(out.reduce((s, p) => s + p.goodsWeightKg, 0)).toBeCloseTo(5);
    expect(out.every((p) => p.pkg?.id === 'only')).toBe(true);
  });

  it('an item larger than every package gets its own custom box', () => {
    const out = packItems([item(100, 50, 30, 9), item(10, 10, 10, 1)], [small]);
    const over = out.find((p) => p.pkg?.id === 'oversize');
    expect(over?.pkg).toMatchObject({ length: 100, width: 50, height: 30, unit: 'cm' });
    expect(over?.goodsWeightKg).toBe(9);
    expect(out.reduce((s, p) => s + p.goodsWeightKg, 0)).toBeCloseTo(10);
  });
});
