/* eslint-disable prettier/prettier */
import { CheckoutService } from './checkout.service';

/**
 * Tax-INCLUSIVE stores: the tax inside the price is EXTRACTED and kept in `includedTaxUSD` /
 * `checkout.includedTaxAmount`; it is never part of `checkoutTotal` (which only adds `taxAmount`).
 */
describe('CheckoutService tax-inclusive pricing', () => {
  const service = new (CheckoutService as any)() as any;
  service.exchangeRateService = { convertWithSnapshots: (a: number) => a };

  const line = (over: any = {}) => ({
    totalPrice: 110, taxUSD: 0, shippingTaxUSD: 0, includedTaxUSD: 10, shippingIncludedTaxUSD: 0, currency: 'USD',
    couponDiscountUSD: 0, giftCardDiscountUSD: 0, storeCreditDiscountUSD: 0, ...over,
  });

  it('total = items + shipping + ADDED tax only (included tax is already inside the price)', () => {
    // 110.00 gross @10% inclusive: included tax 10.00, nothing added
    expect(service.checkoutTotal(110, { shippingFee: 5, taxAmount: 0 })).toBe(115);
  });

  it('coupon shrinks the tax inside the price proportionally and never touches taxAmount', () => {
    const items: any[] = [line()];
    const checkout: any = { currency: 'USD', fxSnapshots: [], taxAmount: 0, includedTaxAmount: 10 };
    // 55 off a 110 line -> 55 left, included tax halves
    items[0].couponDiscountUSD = 55; items[0].totalPrice = 55;
    service.requoteItemTax(items, checkout);
    expect(items[0].includedTaxUSD).toBe(5);
    expect(checkout.includedTaxAmount).toBe(5);
    expect(checkout.taxAmount).toBe(0);
    // coupon removed -> restored
    items[0].couponDiscountUSD = 0; items[0].totalPrice = 110;
    service.requoteItemTax(items, checkout);
    expect(items[0].includedTaxUSD).toBe(10);
    expect(checkout.includedTaxAmount).toBe(10);
  });

  it('keeps the shipping share of included tax when the item part is re-quoted', () => {
    const items: any[] = [line({ totalPrice: 100, includedTaxUSD: 12, shippingIncludedTaxUSD: 2 })];
    const checkout: any = { currency: 'USD', fxSnapshots: [], taxAmount: 0, includedTaxAmount: 12 };
    items[0].couponDiscountUSD = 50; items[0].totalPrice = 50;
    service.requoteItemTax(items, checkout);
    expect(items[0].includedTaxUSD).toBe(7); // item part 10 -> 5, + shipping share 2
  });

  it('legacy (exclusive) lines without included-tax fields are unaffected', () => {
    const items: any[] = [{ totalPrice: 100, taxUSD: 10, shippingTaxUSD: 0, currency: 'USD', couponDiscountUSD: 0, giftCardDiscountUSD: 0, storeCreditDiscountUSD: 0 }];
    const checkout: any = { currency: 'USD', fxSnapshots: [], taxAmount: 10 };
    items[0].couponDiscountUSD = 50; items[0].totalPrice = 50;
    service.requoteItemTax(items, checkout);
    expect(items[0].taxUSD).toBe(5);
    expect(checkout.taxAmount).toBe(5);
    expect(checkout.includedTaxAmount).toBe(0);
  });
});
