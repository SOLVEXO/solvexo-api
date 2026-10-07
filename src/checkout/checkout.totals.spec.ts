/* eslint-disable prettier/prettier */
import { CheckoutService } from './checkout.service';

/**
 * `checkoutTotal` is the single place a checkout's payable total is derived.
 * Before it existed, every recompute after `createCheckout` (shipping, coupon,
 * gift card, reward voucher and their removals) used `subtotal + shipping`,
 * silently dropping the tax that `createCheckout` had added — the buyer paid
 * without tax while the order and the seller's ledger counted it.
 */
describe('CheckoutService.checkoutTotal', () => {
  // Pure arithmetic helper — no collaborators needed.
  const service = new (CheckoutService as any)() as CheckoutService;

  it('is items + shipping + tax', () => {
    expect(service.checkoutTotal(100, { shippingFee: 10, taxAmount: 8 })).toBe(118);
  });

  it('REGRESSION: tax fixed at checkout creation survives a later recompute (e.g. after a coupon lowers the subtotal)', () => {
    const checkout = { shippingFee: 5, taxAmount: 12 };
    // coupon: subtotal 100 -> 80
    expect(service.checkoutTotal(80, checkout)).toBe(97); // 80 + 5 + 12, NOT 85
  });

  it('treats missing shipping/tax as zero (tax-free store, shipping not chosen yet)', () => {
    expect(service.checkoutTotal(50, {})).toBe(50);
    expect(service.checkoutTotal(50, { shippingFee: null, taxAmount: undefined })).toBe(50);
  });

  it('rounds to cents', () => {
    expect(service.checkoutTotal(10.005, { shippingFee: 0.001, taxAmount: 0.002 })).toBe(10.01);
    expect(service.checkoutTotal(0.1, { shippingFee: 0.2, taxAmount: 0 })).toBe(0.3); // no float drift
  });
});

/**
 * `requoteItemTax`: Shopify taxes the discounted price. A coupon/voucher lowers each item's item-tax
 * proportionally, removing it restores, shipping tax is untouched, and gift card / store credit
 * (payment-like) never change tax.
 */
describe('CheckoutService.requoteItemTax', () => {
  const service = new (CheckoutService as any)() as any;
  // same-currency checkout: convertWithSnapshots is the identity
  service.exchangeRateService = { convertWithSnapshots: (a: number) => a };

  const mk = () => {
    // item A: 100 @10% = 10 tax, item B: 50 @10% = 5 tax, item C: 50 untaxed. checkout tax 15 + 2 shipping tax on A
    const items: any[] = [
      { totalPrice: 100, taxUSD: 12, shippingTaxUSD: 2, currency: 'USD', couponDiscountUSD: 0, giftCardDiscountUSD: 0, storeCreditDiscountUSD: 0 },
      { totalPrice: 50, taxUSD: 5, shippingTaxUSD: 0, currency: 'USD', couponDiscountUSD: 0, giftCardDiscountUSD: 0, storeCreditDiscountUSD: 0 },
      { totalPrice: 50, taxUSD: 0, shippingTaxUSD: 0, currency: 'USD', couponDiscountUSD: 0, giftCardDiscountUSD: 0, storeCreditDiscountUSD: 0 },
    ];
    const checkout: any = { currency: 'USD', fxSnapshots: [], taxAmount: 17 };
    return { items, checkout };
  };
  const applyCoupon = (items: any[], discounts: number[]) =>
    items.forEach((it, i) => { it.couponDiscountUSD = discounts[i]; it.totalPrice -= discounts[i]; });

  it('coupon lowers item tax proportionally, keeps shipping tax, and taxAmount follows', () => {
    const { items, checkout } = mk();
    applyCoupon(items, [20, 10, 10]); // 20% off everything
    expect(service.requoteItemTax(items, checkout)).toBe(14); // A: 10*0.8+2 ship = 10, B: 5*0.8 = 4, C: 0
  });

  it('is idempotent and remove restores the original tax', () => {
    const { items, checkout } = mk();
    applyCoupon(items, [20, 10, 10]);
    service.requoteItemTax(items, checkout);
    const once = checkout.taxAmount;
    service.requoteItemTax(items, checkout);
    expect(checkout.taxAmount).toBe(once);
    // revert
    items.forEach((it) => { it.totalPrice += it.couponDiscountUSD; it.couponDiscountUSD = 0; });
    service.requoteItemTax(items, checkout);
    expect(checkout.taxAmount).toBe(17);
    expect(items.map((i) => i.taxUSD)).toEqual([12, 5, 0]);
  });

  it('untaxed items stay 0 and a fully discounted taxed item pays no item tax', () => {
    const { items, checkout } = mk();
    applyCoupon(items, [0, 50, 0]);
    service.requoteItemTax(items, checkout);
    expect(items[1].taxUSD).toBe(0);
    expect(items[2].taxUSD).toBe(0);
    expect(items[0].taxUSD).toBe(12);
    expect(checkout.taxAmount).toBe(12);
  });

  it('gift card / store credit do not change tax', () => {
    const { items, checkout } = mk();
    items.forEach((it) => { it.giftCardDiscountUSD = it.totalPrice / 2; it.totalPrice /= 2; });
    items[0].storeCreditDiscountUSD = 10; items[0].totalPrice -= 10;
    service.requoteItemTax(items, checkout);
    expect(checkout.taxAmount).toBe(17);
    expect(items.map((i) => i.taxUSD)).toEqual([12, 5, 0]);
  });
});
