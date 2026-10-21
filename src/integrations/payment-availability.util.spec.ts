/* eslint-disable prettier/prettier */
import { paymentAvailability, resolveStoreCountry, stripeConnectCountries } from './payment-availability.util';

describe('payment availability by store country', () => {
  const OLD = process.env.STRIPE_CONNECT_COUNTRIES;
  afterEach(() => {
    if (OLD === undefined) delete process.env.STRIPE_CONNECT_COUNTRIES;
    else process.env.STRIPE_CONNECT_COUNTRIES = OLD;
  });

  it('Pakistani gateways are only for Pakistan stores', () => {
    for (const p of ['safepay', 'payfast', 'jazzcash', 'easypaisa', 'bank_transfer'] as const) {
      expect(paymentAvailability(p, 'PK').available).toBe(true);
      const us = paymentAvailability(p, 'US');
      expect(us.available).toBe(false);
      expect(us.reason).toMatch(/only available for stores in Pakistan/);
    }
  });

  it('Stripe defaults to the US only and explains why elsewhere', () => {
    delete process.env.STRIPE_CONNECT_COUNTRIES;
    expect(stripeConnectCountries()).toEqual(['US']);
    expect(paymentAvailability('stripe', 'US').available).toBe(true);
    expect(paymentAvailability('stripe', 'PK').reason).toMatch(/does not support businesses in Pakistan/);
    expect(paymentAvailability('stripe', 'GB').reason).toMatch(/United Kingdom/);
  });

  it('Stripe countries can be extended through the env list', () => {
    process.env.STRIPE_CONNECT_COUNTRIES = 'us, gb ,xx!';
    expect(stripeConnectCountries()).toEqual(['US', 'GB']);
    expect(paymentAvailability('stripe', 'GB').available).toBe(true);
  });

  it('an unknown country asks the seller to set it', () => {
    expect(paymentAvailability('stripe', null).reason).toMatch(/Set your store country/);
    expect(paymentAvailability('safepay', null).available).toBe(false);
  });

  it('resolveStoreCountry prefers the stored country, then the pricing currency', () => {
    expect(resolveStoreCountry({ country: 'gb', baseCurrency: 'PKR' })).toBe('GB');
    expect(resolveStoreCountry({ country: null, baseCurrency: 'PKR' })).toBe('PK');
    expect(resolveStoreCountry({ country: null, baseCurrency: 'USD' })).toBe('US');
    expect(resolveStoreCountry({ country: null, baseCurrency: 'EUR' })).toBeNull();
  });
});
