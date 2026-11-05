/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { assertBundleInStock, bundleAvailability, expandForStock, stockLinesForItem, validateBundleShape } from './bundle.util';
import { assertPreorderShippable, normalizePreorderInput, preorderBlockers, preorderCanFill, preorderPublicView, preorderRemaining } from './preorder.util';
import { fulfilStockForSellerOrders } from './fulfil-stock.util';

const A = 'a'.repeat(24), B = 'b'.repeat(24), P1 = '1'.repeat(24), P2 = '2'.repeat(24), SELF = '9'.repeat(24);
const v = (over: any = {}) => ({ stock: 10, committedStock: 0, ...over });

describe('bundle availability', () => {
  it('is the min over components of floor(available / qty)', () => {
    const vs = new Map([[A, v({ stock: 10 })], [B, v({ stock: 7, committedStock: 1 })]]);
    expect(bundleAvailability([{ productId: P1, variantId: A, quantity: 3 }, { productId: P2, variantId: B, quantity: 2 }], vs)).toBe(3); // min(3, 3)
    expect(bundleAvailability([{ productId: P1, variantId: A, quantity: 4 }], vs)).toBe(2);
  });
  it('is 0 when a component is missing/deleted and null when every component is unlimited', () => {
    expect(bundleAvailability([{ productId: P1, variantId: A, quantity: 1 }], new Map())).toBe(0);
    expect(bundleAvailability([{ productId: P1, variantId: A, quantity: 1 }], new Map([[A, v({ unlimitedStock: true })]]))).toBeNull();
  });
  it('respects reserved/damaged stock and never goes negative', () => {
    expect(bundleAvailability([{ productId: P1, variantId: A, quantity: 1 }], new Map([[A, v({ stock: 2, committedStock: 5 })]]))).toBe(0);
  });
});

describe('bundle stock lines', () => {
  it('expands a bundle line into components x quantity and leaves normal lines alone', () => {
    const line = { variantId: 'own', quantity: 2, name: 'Kit', bundleComponents: [{ productId: P1, variantId: A, quantity: 3, name: 'Pen' }, { productId: P2, variantId: B, quantity: 1, name: 'Ink' }] };
    expect(stockLinesForItem(line)).toEqual([{ variantId: A, quantity: 6, name: 'Pen' }, { variantId: B, quantity: 2, name: 'Ink' }]);
    expect(stockLinesForItem({ variantId: 'x', quantity: 4, name: 'N', bundleComponents: [] })).toEqual([{ variantId: 'x', quantity: 4, name: 'N' }]);
    expect(expandForStock(line).map((l) => l.variantId)).toEqual([A, B]);
    expect(expandForStock({ variantId: 'x', quantity: 1 })).toHaveLength(1);
  });
  it('fulfilment decrements the COMPONENTS (not the bundle variant) and a partial snapshot stays stable if the bundle later changes', async () => {
    const updates: any[] = [];
    const model = { updateOne: jest.fn(async (f: any, u: any) => { updates.push([f._id, JSON.stringify(u)]); }) };
    const so = { status: 'pending', items: [{ type: 'physical', variantId: 'own', quantity: 2, bundleComponents: [{ productId: P1, variantId: A, quantity: 3 }] }] };
    await fulfilStockForSellerOrders(model, [so]);
    expect(updates.map((u) => u[0])).toEqual([A]);
    expect(updates[0][1]).toContain('6');
  });
  it('checkout pre-flight rejects when any component is short', async () => {
    const model = { find: () => ({ lean: async () => [{ _id: A, stock: 1 }, { _id: B, stock: 50 }] }) };
    const ok = (vv: any, q: number) => vv.stock >= q;
    await expect(assertBundleInStock(model, [{ productId: P1, variantId: A, quantity: 2 }], 1, 'Kit', ok)).rejects.toBeInstanceOf(BadRequestException);
    await expect(assertBundleInStock(model, [{ productId: P2, variantId: B, quantity: 2 }], 5, 'Kit', ok)).resolves.toBeUndefined();
  });
});

describe('bundle validation', () => {
  const bad = (x: any) => expect(() => validateBundleShape(x, SELF)).toThrow(BadRequestException);
  it('rejects empty, too many, bad ids, bad quantities, duplicates and itself', () => {
    bad([]); bad('x'); bad(Array.from({ length: 21 }, (_, i) => ({ productId: P1, variantId: String(i).padStart(24, '0'), quantity: 1 })));
    bad([{ productId: 'x', variantId: A, quantity: 1 }]);
    bad([{ productId: P1, variantId: A, quantity: 0 }]); bad([{ productId: P1, variantId: A, quantity: 1.5 }]); bad([{ productId: P1, variantId: A, quantity: '2' }]);
    bad([{ productId: P1, variantId: A, quantity: 1 }, { productId: P2, variantId: A, quantity: 1 }]);
    bad([{ productId: SELF, variantId: A, quantity: 1 }]);
  });
  it('accepts a clean list', () => {
    expect(validateBundleShape([{ productId: P1, variantId: A, quantity: 2 }], SELF)).toEqual([{ productId: P1, variantId: A, quantity: 2 }]);
  });
});

describe('pre-order', () => {
  const now = new Date('2026-11-05T00:00:00Z');
  it('normalizes settings and rejects bad input', () => {
    expect(normalizePreorderInput({ enabled: true, expectedDate: '2026-12-01', limit: 5, message: ' Ships soon ' }, 2, now)).toMatchObject({ enabled: true, limit: 5, message: 'Ships soon', sold: 2 });
    expect(normalizePreorderInput(null)).toBeNull();
    for (const bad of [{ enabled: true, expectedDate: 'soon' }, { enabled: true, expectedDate: '2020-01-01' }, { enabled: true, limit: 0 }, { enabled: true, limit: 1.5 }, { enabled: true, $set: 1 }, 'x']) {
      expect(() => normalizePreorderInput(bad as any, 0, now)).toThrow(BadRequestException);
    }
  });
  it('public view only shows while enabled AND out of stock; remaining reflects the limit', () => {
    const pre = { enabled: true, expectedDate: '2026-12-01', limit: 10, sold: 4, message: 'm' };
    expect(preorderPublicView(pre, 0)).toMatchObject({ label: 'Pre-order', remaining: 6, soldOut: false });
    expect(preorderPublicView(pre, 3)).toBeNull(); // stock > 0 => normal purchase
    expect(preorderPublicView({ ...pre, sold: 10 }, 0)?.soldOut).toBe(true);
    expect(preorderPublicView(null, 0)).toBeNull();
    expect(preorderCanFill({ enabled: false })).toBe(false);
    expect(preorderRemaining({ enabled: true, limit: null })).toBeNull();
  });
  it('fulfilment guard blocks un-stocked pre-order lines unless overridden, and never touches normal lines', async () => {
    const model = { find: () => ({ select: () => ({ lean: async () => [{ _id: A, stock: 0 }] }) }) };
    const line = { item: { isPreorder: true, name: 'Gadget', variantId: A, preorderExpectedDate: new Date('2026-12-01') }, quantity: 1 };
    await expect(assertPreorderShippable(model, [line], false)).rejects.toThrow(/not in stock yet/);
    await expect(assertPreorderShippable(model, [line], true)).resolves.toMatchObject({ overridden: true, names: ['Gadget'] });
    await expect(assertPreorderShippable(model, [{ item: { isPreorder: false, variantId: A }, quantity: 1 }], false)).resolves.toMatchObject({ overridden: false });
    expect(preorderBlockers([{ item: { isPreorder: true, name: 'x', variantId: A }, quantity: 1 }], new Map([[A, { stock: 5 }]]))).toEqual([]);
  });
});
