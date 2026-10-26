/* eslint-disable prettier/prettier */
import { getInvoiceTaxCents, invoiceTaxSnapshot, pickPlatformTaxRate, taxOnNet, PlatformTaxRate } from './platform-tax.util';

const rate = (over: Partial<PlatformTaxRate> = {}): PlatformTaxRate => ({
  id: 'r1', country: 'PK', label: 'Sales Tax', ratePercent: 17, status: 'confirmed', effectiveFrom: null, ...over,
});

describe('pickPlatformTaxRate', () => {
  it('charges a confirmed rate for the seller country', () => {
    const p = pickPlatformTaxRate([rate()], 'pk');
    expect(p.reason).toBe('ok');
    expect(p.rate?.ratePercent).toBe(17);
  });
  it('never charges a draft rate', () => {
    expect(pickPlatformTaxRate([rate({ status: 'draft' })], 'PK')).toEqual({ rate: null, reason: 'not_confirmed' });
  });
  it('never silently taxes (or zero-rates) a country that is not listed', () => {
    expect(pickPlatformTaxRate([rate()], 'AE')).toEqual({ rate: null, reason: 'not_listed' });
  });
  it('needs a known country', () => {
    expect(pickPlatformTaxRate([rate()], null).reason).toBe('no_country');
  });
  it('respects the effective date and picks the newest rate that has started', () => {
    const rates = [
      rate({ id: 'old', ratePercent: 16, effectiveFrom: '2026-01-01' }),
      rate({ id: 'new', ratePercent: 18, effectiveFrom: '2026-11-01' }),
    ];
    expect(pickPlatformTaxRate(rates, 'PK', new Date('2026-10-26')).rate?.id).toBe('old');
    expect(pickPlatformTaxRate(rates, 'PK', new Date('2026-11-02')).rate?.id).toBe('new');
    expect(pickPlatformTaxRate([rate({ effectiveFrom: '2027-01-01' })], 'PK', new Date('2026-10-26')).reason).toBe('not_effective');
  });
  it('a confirmed 0% rate means no tax', () => {
    expect(pickPlatformTaxRate([rate({ ratePercent: 0 })], 'PK')).toEqual({ rate: null, reason: 'zero' });
  });
});

describe('taxOnNet', () => {
  it('adds tax on top, rounded to the cent', () => {
    expect(taxOnNet(50, 17)).toEqual({ taxUSD: 8.5, totalUSD: 58.5 });
    expect(taxOnNet(29.99, 16)).toEqual({ taxUSD: 4.8, totalUSD: 34.79 });
  });
});

describe('getInvoiceTaxCents', () => {
  it('reads every Stripe invoice shape', () => {
    expect(getInvoiceTaxCents({ tax: 850 })).toBe(850);
    expect(getInvoiceTaxCents({ total_tax_amounts: [{ amount: 500 }, { amount: 100 }] })).toBe(600);
    expect(getInvoiceTaxCents({ total_taxes: [{ amount: 300 }] })).toBe(300);
    expect(getInvoiceTaxCents({})).toBe(0);
    expect(getInvoiceTaxCents(null)).toBe(0);
  });
});

describe('invoiceTaxSnapshot', () => {
  it('carves the tax out of the total paid and derives the rate', () => {
    expect(invoiceTaxSnapshot({ amount_paid: 5850, tax: 850 }, 58.5)).toEqual({ subtotalUSD: 50, taxAmountUSD: 8.5, taxRatePercent: 17 });
  });
  it('an invoice without tax stays untouched', () => {
    expect(invoiceTaxSnapshot({ amount_paid: 5000 }, 50)).toEqual({ subtotalUSD: 50, taxAmountUSD: 0, taxRatePercent: 0 });
  });
  it('never lets the tax exceed what was paid', () => {
    expect(invoiceTaxSnapshot({ tax: 9999 }, 10)).toEqual({ subtotalUSD: 0, taxAmountUSD: 10, taxRatePercent: 0 });
  });
});
