/* eslint-disable prettier/prettier */
/** REGRESSION (staging smoke): shipping a bundle must move its COMPONENTS' stock even when the order is a hydrated Mongoose document. */
import { OrdersService } from './orders.service';

// Mimics a hydrated sub-document: the schema fields are prototype getters, so a plain object spread loses them.
class HydratedItem {
  constructor(private readonly raw: any) {}
  get type() { return this.raw.type; }
  get variantId() { return this.raw.variantId; }
  get quantity() { return this.raw.quantity; }
  get bundleComponents() { return this.raw.bundleComponents; }
  get costOfGoodsSold() { return 0; }
  toObject() { return { ...this.raw }; }
}

describe('OrdersService.deductShippedStock with a bundle line', () => {
  it('drops on-hand stock and the reservation of every component (qty x component qty), not of the bundle itself', async () => {
    const updates: any[] = [];
    const svc: any = Object.create(OrdersService.prototype);
    svc.databaseService = { repositories: {
      productVariantModel: {
        findOne: () => ({ select: () => ({ lean: async () => ({ unlimitedStock: false, trackLots: false }) }) }),
        updateOne: async (filter: any) => { updates.push(filter._id); },
      },
      variantLocationStockModel: { find: () => ({ session: () => ({ lean: async () => [] }) }) },
    } };
    const bundle = new HydratedItem({ type: 'physical', variantId: 'bundle-variant', quantity: 2, bundleComponents: [{ productId: 'p1', variantId: 'shirt', quantity: 1 }, { productId: 'p2', variantId: 'socks', quantity: 2 }] });
    await svc.deductShippedStock({ items: [bundle] }, 0, [{ itemIndex: 0, itemId: 'i1', quantity: 2 }]);
    expect(updates.sort()).toEqual(['shirt', 'socks']);
  });
});
