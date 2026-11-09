/* eslint-disable prettier/prettier */
/** REGRESSION (staging smoke 2): spreading hydrated sub-documents lost their fields in several helpers. */
import { plain } from './plain.util';
import { assertPreorderShippable, preorderBlockers } from './preorder.util';
import { withEffectiveReturnStatus } from './return-status.util';
import { toBuyerSafeOrder } from './buyer-safe-order.util';

// Mimics a hydrated sub-document: schema fields are prototype getters, so a plain spread copies nothing.
class Hydrated {
  constructor(private readonly raw: Record<string, any>) {}
  get name() { return this.raw.name; }
  get variantId() { return this.raw.variantId; }
  get isPreorder() { return this.raw.isPreorder; }
  get preorderExpectedDate() { return this.raw.preorderExpectedDate; }
  get bundleComponents() { return this.raw.bundleComponents; }
  get returnStatus() { return this.raw.returnStatus; }
  get status() { return this.raw.status; }
  get quantity() { return this.raw.quantity; }
  toObject() { return { ...this.raw }; }
}

describe('plain()', () => {
  it('turns a hydrated value into a spreadable object and leaves plain objects alone', () => {
    const h = new Hydrated({ variantId: 'v1' });
    expect({ ...h }).toEqual({ raw: { variantId: 'v1' } }); // proves the trap
    expect({ ...plain(h) }).toEqual({ variantId: 'v1' });
    const o = { a: 1 }; expect(plain(o)).toBe(o); expect(plain(null)).toBeNull();
  });
});

describe('pre-order shipping guard with hydrated order lines', () => {
  const item = new Hydrated({ name: 'Pre', variantId: 'v1', isPreorder: true, preorderExpectedDate: new Date('2026-12-01'), quantity: 2 });
  it('still finds the missing stock (before: the spread dropped variantId, so the guard never fired)', () => {
    const blockers = preorderBlockers([{ item, quantity: 2 }], new Map([['v1', { stock: 0 }]]));
    expect(blockers).toHaveLength(1); expect(blockers[0].name).toBe('Pre');
  });
  it('and for a bundle line it checks the components', () => {
    const bundle = new Hydrated({ name: 'B', variantId: 'bv', isPreorder: true, quantity: 1, bundleComponents: [{ productId: 'p', variantId: 'c1', quantity: 2 }] });
    expect(preorderBlockers([{ item: bundle, quantity: 1 }], new Map([['c1', { stock: 1 }]]))).toHaveLength(1);
    expect(preorderBlockers([{ item: bundle, quantity: 1 }], new Map([['c1', { stock: 5 }]]))).toHaveLength(0);
  });
  it('assertPreorderShippable refuses without override and allows with it', async () => {
    const model: any = { find: () => ({ select: () => ({ lean: async () => [{ _id: 'v1', stock: 0 }] }) }) };
    await expect(assertPreorderShippable(model, [{ item, quantity: 2 }], false)).rejects.toThrow();
    expect((await assertPreorderShippable(model, [{ item, quantity: 2 }], true)).overridden).toBe(true);
  });
});

describe('other spreads', () => {
  it('withEffectiveReturnStatus keeps every field of a hydrated line', () => {
    const line: any = new Hydrated({ name: 'Shirt', status: 'delivered', returnStatus: 'approved', quantity: 1, refundedAt: null });
    const out: any = withEffectiveReturnStatus(Object.assign(line, {}));
    expect(out.name).toBe('Shirt');
  });
  it('toBuyerSafeOrder keeps the data of a hydrated order and sub-order', () => {
    const so = new Hydrated({ name: 'so', status: 'shipped' });
    const order: any = { toObject: () => ({ orderNumber: 'O1', sellerOrders: [so], trackingNumber: 't' }) };
    const safe = toBuyerSafeOrder(order);
    expect(safe.orderNumber).toBe('O1'); expect(safe.sellerOrders[0].status).toBe('shipped');
  });
});
