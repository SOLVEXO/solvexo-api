import { fromStripeAmount, roundStripeMinor, stripeMinorUnitFactor, toStripeAmount } from './stripe-amount.util';

describe('stripe-amount.util (Stripe minor units, docs.stripe.com/currencies)', () => {
  it('two-decimal currencies are ×100 (USD, EUR, PKR)', () => {
    expect(toStripeAmount(10.99, 'USD')).toBe(1099);
    expect(toStripeAmount(10, 'eur')).toBe(1000);
    expect(toStripeAmount(2500, 'PKR')).toBe(250000);
    expect(fromStripeAmount(1099, 'usd')).toBe(10.99);
  });

  it('zero-decimal currencies are whole units (JPY, KRW, VND)', () => {
    expect(toStripeAmount(500, 'JPY')).toBe(500);
    expect(toStripeAmount(1234.6, 'KRW')).toBe(1235);
    expect(fromStripeAmount(500, 'jpy')).toBe(500);
    expect(stripeMinorUnitFactor('VND')).toBe(1);
  });

  it('ISK and UGX are whole units sent as a two-decimal value', () => {
    expect(toStripeAmount(5, 'ISK')).toBe(500);
    expect(toStripeAmount(5.4, 'UGX')).toBe(500);
    expect(fromStripeAmount(500, 'isk')).toBe(5);
    expect(roundStripeMinor(1234, 'UGX')).toBe(1200);
  });

  it('three-decimal currencies are ×1000 with a trailing 0', () => {
    expect(toStripeAmount(1.234, 'KWD')).toBe(1230);
    expect(toStripeAmount(1.236, 'BHD')).toBe(1240);
    expect(toStripeAmount(1.234, 'KWD') % 10).toBe(0);
    expect(fromStripeAmount(1230, 'kwd')).toBe(1.23);
    expect(roundStripeMinor(1234, 'OMR')).toBe(1230);
  });

  it('writing then reading returns the same amount for a charge in every class', () => {
    for (const [amount, cur] of [[19.99, 'USD'], [3000, 'JPY'], [7, 'ISK'], [4.5, 'KWD'], [1500, 'PKR']] as const) {
      expect(fromStripeAmount(toStripeAmount(amount, cur), cur)).toBe(amount);
    }
  });

  it('missing currency defaults to USD rules', () => {
    expect(toStripeAmount(1, null)).toBe(100);
    expect(fromStripeAmount(100, undefined)).toBe(1);
  });
});
