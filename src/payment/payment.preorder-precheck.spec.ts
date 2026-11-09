/* eslint-disable prettier/prettier */
/** REGRESSION (staging smoke): the friendly stock pre-check at COD time refused a pre-order variant that is sold out. */
import { PaymentService } from './payment.service';

function build(variant: any) {
  const checkout = { _id: { toString: () => 'c1' }, status: 'open', expiredAt: null, items: [{ type: 'physical', variantId: 'v1', productId: 'p1', storeId: 's1', name: 'Pre', quantity: 2 }], totalAmount: 100, currency: 'PKR', fxSnapshots: [] };
  const models: any = {
    checkoutModel: { findOne: async () => checkout, findByIdAndUpdate: async () => undefined, updateOne: async () => undefined },
    productVariantModel: { findOne: async () => variant },
    paymentTransactionModel: { create: async () => ({}) },
    orderModel: {}, addressModel: {}, cartModel: { updateOne: async () => undefined, deleteOne: async () => undefined, findOne: async () => null },
    storeModel: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
  };
  const svc: any = Object.create(PaymentService.prototype);
  svc.databaseService = { repositories: models };
  svc.assertDiscountsStillValid = async () => undefined;
  svc.codProtection = undefined;
  svc.createOrder = jest.fn(async () => []);
  return svc as any;
}

describe('codPayment stock pre-check', () => {
  const soldOut = { _id: 'v1', stock: 0, committedStock: 0, unlimitedStock: false, allowBackorder: false };
  it('refuses a sold-out variant with no pre-order and no backorder', async () => {
    await expect(build({ ...soldOut }).codPayment('u1', { checkoutId: 'c1' })).rejects.toThrow(/Insufficient stock/);
  });
  it('lets a sold-out variant through when pre-order is on (the atomic reserve in createOrder enforces the limit)', async () => {
    const svc = build({ ...soldOut, preorder: { enabled: true, limit: 5, sold: 0, expectedDate: null } });
    await svc.codPayment('u1', { checkoutId: 'c1' }).catch((e: any) => { if (/Insufficient stock/.test(String(e?.message))) throw e; });
    expect(svc.createOrder).toHaveBeenCalled();
  });
});
