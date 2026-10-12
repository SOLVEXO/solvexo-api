/* eslint-disable prettier/prettier */
import { isDirectSale, refundGiftCreditShare, sellerCashBasis, sellerGiftCreditShare, sellerPayoutBasis } from './seller-payout-basis.util';

// 1000 order: 400 paid with a gift card, 600 in cash; PKR store, buyer also PKR (rate 1).
const so = (over: any = {}) => ({
  subtotal: 600, taxAmount: 0, platformSponsoredDiscountUSD: 0, settlementAmount: 600, settlementCurrency: 'PKR', settledViaConnect: false,
  items: [
    { totalPrice: 300, giftCardDiscountUSD: 200, storeCreditDiscountUSD: 0 },
    { totalPrice: 300, giftCardDiscountUSD: 100, storeCreditDiscountUSD: 100 },
  ],
  ...over,
});
const cod = { paymentType: 'cash_on_delivery' };
const platformCard = { paymentType: 'stripe' };

describe('seller payout basis — gift card / store credit are a way of paying, not a discount', () => {
  it('a direct (COD) sale is recorded at the FULL sale: cash + the part paid with gift card / store credit', () => {
    expect(sellerCashBasis(so())).toBe(600);
    expect(sellerPayoutBasis(so(), cod)).toBe(1000);
    expect(sellerGiftCreditShare(so(), cod)).toBe(400);
  });

  it('a Connect card sale counts as direct too', () => {
    expect(isDirectSale(so({ settledViaConnect: true }), platformCard)).toBe(true);
    expect(sellerPayoutBasis(so({ settledViaConnect: true }), platformCard)).toBe(1000);
  });

  it('a platform-held card sale keeps the cash basis (the platform never held the gift-card share)', () => {
    expect(isDirectSale(so(), platformCard)).toBe(false);
    expect(sellerPayoutBasis(so(), platformCard)).toBe(600);
    expect(sellerGiftCreditShare(so(), platformCard)).toBe(0);
  });

  it('converts the share into the seller\'s settlement currency with the sellerOrder\'s own rate', () => {
    // buyer paid in USD-ish order currency, settlement is 10x (PKR-like): cash 600 -> 6000
    const s = so({ settlementAmount: 6000 });
    expect(sellerGiftCreditShare(s, cod)).toBe(4000);
    expect(sellerPayoutBasis(s, cod)).toBe(10000);
  });

  it('tax is unaffected: the cash basis, not the full sale, is what tax shares are computed from', () => {
    const s = so({ taxAmount: 60, settlementAmount: 660 });
    expect(sellerCashBasis(s)).toBe(660);
    expect(sellerPayoutBasis(s, cod)).toBe(1060);
  });

  it('refunding items hands their gift-card share back too (so a full refund leaves nothing of the sale behind)', () => {
    const s = so();
    expect(refundGiftCreditShare(s, cod, s.items)).toBe(400);
    expect(refundGiftCreditShare(s, cod, [s.items[0]])).toBe(200);
    expect(refundGiftCreditShare(s, cod, s.items, 0.5)).toBe(200); // refund was clamped to half by the shared budget
    expect(refundGiftCreditShare(s, platformCard, s.items)).toBe(0); // platform-held: never credited, never clawed back
  });

  it('an order paid without gift card / credit is unchanged', () => {
    const s = so({ items: [{ totalPrice: 600 }] });
    expect(sellerPayoutBasis(s, cod)).toBe(600);
    expect(refundGiftCreditShare(s, cod, s.items)).toBe(0);
  });
});
