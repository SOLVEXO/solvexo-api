/* eslint-disable prettier/prettier */
jest.mock('../database/databaseservice', () => ({ DatabaseService: class {} }));

import { BadRequestException } from '@nestjs/common';
import { OrderEditingService } from './order-editing.service';

const STORE = 'store1';
const SELLER = 'seller1';
const OID = '64b000000000000000000001';

const chain = (v: any) => { const c: any = { lean: () => Promise.resolve(v), select: () => c, session: () => c }; return c; };

function build(soExtra: any = {}, locationRows: any[] = []) {
  const plain: any = {
    _id: OID, orderStatus: 'pending', isPaid: false, paymentType: 'cash_on_delivery', currency: 'USD', fxSnapshots: [], totalAmount: 100,
    subtotal: 100, taxAmount: 0, userId: 'u1', orderNumber: 'N1', updatedAt: new Date(),
    sellerOrders: [{
      storeId: STORE, sellerId: SELLER, status: 'pending', subtotal: 100, taxAmount: 0, settlementAmount: 100,
      items: [
        { _id: 'it1', type: 'physical', variantId: 'v1', name: 'Shirt', quantity: 4, totalPrice: 80, taxUSD: 0, status: 'pending' },
        { _id: 'it2', type: 'physical', variantId: 'v2', name: 'Hat', quantity: 1, totalPrice: 20, taxUSD: 0, status: 'pending' },
      ],
      ...soExtra,
    }],
  };
  const order: any = { ...plain, toObject: () => JSON.parse(JSON.stringify(plain)) };
  const productVariantModel: any = {
    findOne: jest.fn(() => chain({ unlimitedStock: false })),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const variantLocationStockModel: any = { find: jest.fn(() => chain(locationRows)), updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
  const orderModel: any = {
    findOne: jest.fn().mockResolvedValue(order),
    findOneAndUpdate: jest.fn().mockResolvedValue({ _id: OID }),
    updateOne: jest.fn().mockResolvedValue({}),
  };
  const storeModel: any = { findOne: jest.fn(() => chain({ baseCurrency: 'USD', name: 'S' })) };
  const storeLocationModel: any = { findOne: jest.fn(() => chain(null)) };
  const db: any = { repositories: { orderModel, storeModel, productVariantModel, variantLocationStockModel, storeLocationModel } };
  const svc = new OrderEditingService(
    db, { log: jest.fn() } as any, { notify: jest.fn().mockResolvedValue(undefined), sendCustomerEmail: jest.fn().mockResolvedValue(undefined) } as any,
    { convertWithSnapshots: (n: number) => n } as any, {} as any, {} as any, { syncDirectSale: jest.fn().mockResolvedValue({}) } as any,
  );
  return { svc, productVariantModel, variantLocationStockModel, orderModel };
}

const actor: any = { actorId: SELLER, actorRole: 'seller' };

describe('order edit: stock follows the right counter', () => {
  it('a normal (reserved) order edit releases part of the RESERVATION and never touches on-hand stock', async () => {
    const { svc, productVariantModel } = build();
    await svc.editOrder(SELLER, STORE, OID, actor, { changes: [{ itemId: 'it1', quantity: 2 }] } as any);
    const calls = productVariantModel.updateOne.mock.calls.filter((c: any[]) => c[0]._id === 'v1');
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0][1])).toContain('committedStock');
    expect(JSON.stringify(calls[0][1])).not.toContain('"stock"');
  });

  it('a draft-order sale (units already taken out of stock) gives the removed units back to ON-HAND stock instead', async () => {
    const { svc, productVariantModel } = build({ stockAlreadyDeducted: true });
    await svc.editOrder(SELLER, STORE, OID, actor, { changes: [{ itemId: 'it1', quantity: 2 }] } as any);
    const calls = productVariantModel.updateOne.mock.calls.filter((c: any[]) => c[0]._id === 'v1');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ $inc: { stock: 2 } }); // 4 -> 2 = two units back on the shelf
  });

  it('...and into the location row when the variant has per-location stock', async () => {
    const { svc, variantLocationStockModel } = build({ stockAlreadyDeducted: true }, [{ _id: 'row1', locationId: 'L1', stock: 3 }]);
    await svc.editOrder(SELLER, STORE, OID, actor, { changes: [{ itemId: 'it1', quantity: 2 }] } as any);
    expect(variantLocationStockModel.updateOne).toHaveBeenCalledWith({ _id: 'row1' }, { $inc: { stock: 2 } }, expect.anything());
  });

  it('increasing a draft-sale line takes the extra units from on-hand stock behind the shared availability guard; refused when not available', async () => {
    const { svc, productVariantModel } = build({ stockAlreadyDeducted: true });
    productVariantModel.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(svc.editOrder(SELLER, STORE, OID, actor, { changes: [{ itemId: 'it1', quantity: 6 }] } as any)).rejects.toBeInstanceOf(BadRequestException);
    const first = productVariantModel.updateOne.mock.calls[0];
    expect(first[1]).toEqual({ $inc: { stock: -2 } });
    expect(JSON.stringify(first[0])).toContain('expiredStock'); // the guard is the shared availability expression
  });

  it('losing the optimistic-lock race rolls the on-hand change back', async () => {
    const { svc, productVariantModel, orderModel } = build({ stockAlreadyDeducted: true });
    orderModel.findOneAndUpdate.mockResolvedValue(null);
    await expect(svc.editOrder(SELLER, STORE, OID, actor, { changes: [{ itemId: 'it1', quantity: 2 }] } as any)).rejects.toBeInstanceOf(BadRequestException);
    const incs = productVariantModel.updateOne.mock.calls.filter((c: any[]) => c[1]?.$inc?.stock !== undefined).map((c: any[]) => c[1].$inc.stock);
    expect(incs).toEqual([2, -2]); // applied, then undone
  });
});
