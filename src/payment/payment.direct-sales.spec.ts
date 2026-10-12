/* eslint-disable prettier/prettier */
import { PaymentService } from './payment.service';

/** recordDirectSales is private — exercised through the prototype with just the collaborators it uses. */
function makeService() {
  const financeService = { recordSale: jest.fn().mockResolvedValue(undefined) };
  const exchangeRateService = { convertWithSnapshots: jest.fn().mockImplementation((n: number) => n) };
  const svc: any = Object.create(PaymentService.prototype);
  svc.financeService = financeService;
  svc.exchangeRateService = exchangeRateService;
  svc.round = (n: number) => Math.round(n * 100) / 100;
  return { svc, financeService, exchangeRateService };
}

const order = (over: any = {}, so: any = {}) => ({
  _id: 'o1', currency: 'PKR', paymentType: 'cash_on_delivery', fxSnapshots: [],
  sellerOrders: [{ storeId: 's1', sellerId: 'u1', subtotal: 900, taxAmount: 100, settlementAmount: 1000, settlementCurrency: 'PKR', settledViaConnect: false, ...so }],
  ...over,
});

describe('PaymentService.recordDirectSales — sale recorded when the order is placed', () => {
  it('records a COD (manual rail) sale with its tax, flagged as recorded at placement', async () => {
    const { svc, financeService } = makeService();

    await svc.recordDirectSales([order()], null);

    expect(financeService.recordSale).toHaveBeenCalledTimes(1);
    expect(financeService.recordSale).toHaveBeenCalledWith(
      's1', 'u1', 'o1', 1000, expect.any(String), 0, null, 'PKR', 'cash_on_delivery', false, 100, true, 0, 0,
    );
  });

  it('does NOT record a platform-held card sale (credited at completion, when the platform releases it)', async () => {
    const { svc, financeService } = makeService();

    await svc.recordDirectSales([order({ paymentType: 'stripe' })], null);

    expect(financeService.recordSale).not.toHaveBeenCalled();
  });

  it('records a Connect card sale and passes the Stripe application fee once, on the first connect-settled sub-order', async () => {
    const { svc, financeService } = makeService();
    const o = order({ paymentType: 'stripe', sellerOrders: [
      { storeId: 's1', sellerId: 'u1', subtotal: 900, taxAmount: 100, settlementAmount: 1000, settlementCurrency: 'PKR', settledViaConnect: true },
      { storeId: 's1', sellerId: 'u1', subtotal: 500, taxAmount: 0, settlementAmount: 500, settlementCurrency: 'PKR', settledViaConnect: true },
    ] });

    await svc.recordDirectSales([o], { applicationFee: 29.5, feeCurrency: 'PKR' });

    const calls = financeService.recordSale.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][9]).toBe(true); // settledViaConnect
    expect(calls[0][12]).toBe(29.5); // card fee on the first sub-order only
    expect(calls[1][12]).toBe(0);
  });

  it('leaves a sub-order with a platform-sponsored discount to the completion path (that credit must wait for fulfilment)', async () => {
    const { svc, financeService } = makeService();

    await svc.recordDirectSales([order({}, { platformSponsoredDiscountUSD: 50 })], null);

    expect(financeService.recordSale).not.toHaveBeenCalled();
  });

  it('never throws when the ledger write fails (the order is already placed)', async () => {
    const { svc, financeService } = makeService();
    financeService.recordSale.mockRejectedValue(new Error('db down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(svc.recordDirectSales([order()], null)).resolves.toBeUndefined();

    spy.mockRestore();
  });
});

describe('PaymentService.assertDiscountsStillValid — regression: it used to call ITSELF forever (memory blow-up on every payment start)', () => {
  it('re-checks the coupon and the store credit once each, then returns', async () => {
    const svc: any = Object.create(PaymentService.prototype);
    svc.assertCouponStillUsable = jest.fn().mockResolvedValue(undefined);
    svc.assertStoreCreditStillCovers = jest.fn().mockResolvedValue(undefined);
    const checkout = { userId: 'u1' };

    await svc.assertDiscountsStillValid(checkout);

    expect(svc.assertCouponStillUsable).toHaveBeenCalledTimes(1);
    expect(svc.assertStoreCreditStillCovers).toHaveBeenCalledTimes(1);
    expect(svc.assertStoreCreditStillCovers).toHaveBeenCalledWith(checkout);
  });
});
