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
