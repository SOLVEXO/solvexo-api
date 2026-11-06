/* eslint-disable prettier/prettier */
import {
  canManageLocation, checkQuantity, creditLimitCheck, depositRequired, effectiveCompanySettings, effectiveQuantityRule, isOverdue, isPaymentMethodAllowed,
  outstandingBalance, paymentDueDate, paymentStatusOf, resolveCatalogPrice, validateInstallment, validatePaymentTerms, validatePriceBreaks, validateQuantityRuleDefinition,
} from './b2b-pricing.util';

describe('resolveCatalogPrice precedence', () => {
  const entry = { available: true, fixedPrice: 80, adjustmentPercent: -10, priceBreaks: [{ minQty: 10, price: 70 }, { minQty: 50, price: 60 }] };
  it('volume break beats fixed price, fixed beats entry %, entry % beats catalog default, default beats base', () => {
    expect(resolveCatalogPrice(100, entry, 12)).toBe(70);
    expect(resolveCatalogPrice(100, entry, 60)).toBe(60);
    expect(resolveCatalogPrice(100, entry, 5)).toBe(80);
    expect(resolveCatalogPrice(100, { available: true, adjustmentPercent: -10 }, 1, -20)).toBe(90);
    expect(resolveCatalogPrice(100, { available: true }, 1, -20)).toBe(80);
    expect(resolveCatalogPrice(100, { available: true }, 1)).toBe(100);
    expect(resolveCatalogPrice(100, null, 1, 15)).toBe(115);
  });
  it('a volume break is the price itself, not an extra discount', () => {
    expect(resolveCatalogPrice(100, { available: true, adjustmentPercent: -50, priceBreaks: [{ minQty: 5, price: 90 }] }, 5)).toBe(90);
  });
  it('never goes below zero and rounds to cents', () => {
    expect(resolveCatalogPrice(10, { available: true, adjustmentPercent: -150 }, 1)).toBe(0);
    expect(resolveCatalogPrice(9.99, { available: true, adjustmentPercent: -33.3333 }, 1)).toBe(6.66);
  });
  it('exactly at the break quantity uses the break; one below does not', () => {
    expect(resolveCatalogPrice(100, entry, 10)).toBe(70);
    expect(resolveCatalogPrice(100, entry, 9)).toBe(80);
  });
});

describe('validatePriceBreaks', () => {
  it('accepts up to 10 ascending, non-rising breaks', () => {
    expect(validatePriceBreaks(Array.from({ length: 10 }, (_, i) => ({ minQty: i + 2, price: 100 - i })))).toBeNull();
  });
  it('rejects 11, duplicates, descending quantities, rising prices, qty < 2, negative price', () => {
    expect(validatePriceBreaks(Array.from({ length: 11 }, (_, i) => ({ minQty: i + 2, price: 10 })))).toMatch(/At most 10/);
    expect(validatePriceBreaks([{ minQty: 5, price: 9 }, { minQty: 5, price: 8 }])).toMatch(/unique/);
    expect(validatePriceBreaks([{ minQty: 10, price: 9 }, { minQty: 5, price: 8 }])).toMatch(/unique|increasing/);
    expect(validatePriceBreaks([{ minQty: 5, price: 8 }, { minQty: 10, price: 9 }])).toMatch(/cannot cost more/);
    expect(validatePriceBreaks([{ minQty: 1, price: 8 }])).toMatch(/2 or more/);
    expect(validatePriceBreaks([{ minQty: 2, price: -1 }])).toMatch(/0 or more/);
  });
});

describe('quantity rules', () => {
  it('catalog entry wins over the product fields; defaults are 1 / unlimited / 1', () => {
    expect(effectiveQuantityRule({ available: true, minQty: 6, increment: 6 }, { orderMinQuantity: 2, orderMaxQuantity: 100, orderQuantityStep: 1 })).toEqual({ min: 6, max: 100, increment: 6 });
    expect(effectiveQuantityRule(null, null)).toEqual({ min: 1, max: null, increment: 1 });
  });
  it('enforces min, max, increment and whole numbers, with a suggestion', () => {
    const rule = { min: 6, max: 24, increment: 6 };
    expect(checkQuantity(12, rule)).toEqual({ ok: true });
    expect(checkQuantity(3, rule)).toMatchObject({ ok: false, suggested: 6 });
    expect(checkQuantity(30, rule)).toMatchObject({ ok: false, suggested: 24 });
    expect(checkQuantity(13, rule)).toMatchObject({ ok: false, suggested: 12 });
    expect(checkQuantity(1.5, rule)).toMatchObject({ ok: false });
    expect(checkQuantity(0, rule)).toMatchObject({ ok: false });
    expect(checkQuantity(-6, rule)).toMatchObject({ ok: false });
  });
  it('validates rule definitions', () => {
    expect(validateQuantityRuleDefinition({ minQty: 6, maxQty: 24, increment: 6 })).toBeNull();
    expect(validateQuantityRuleDefinition({ minQty: 5, increment: 6 })).toMatch(/multiple/);
    expect(validateQuantityRuleDefinition({ minQty: 12, maxQty: 6, increment: 6 })).toMatch(/above the maximum/);
    expect(validateQuantityRuleDefinition({ minQty: 0 })).toMatch(/whole number/);
  });
});

describe('payment terms and installments', () => {
  const placed = new Date('2026-01-10T00:00:00Z');
  it('computes due dates for each terms type', () => {
    expect(paymentDueDate({ type: 'due_on_order' }, placed)).toEqual(placed);
    expect(paymentDueDate({ type: 'net', netDays: 30 }, placed)).toEqual(new Date('2026-02-09T00:00:00Z'));
    expect(paymentDueDate({ type: 'due_on_fulfilment' }, placed)).toBeNull();
    expect(paymentDueDate({ type: 'due_on_fulfilment' }, placed, new Date('2026-01-20T00:00:00Z'))).toEqual(new Date('2026-01-20T00:00:00Z'));
  });
  it('only allows net 15 / 30 / 60', () => {
    expect(validatePaymentTerms({ type: 'net', netDays: 45 })).toMatch(/15, 30, 60/);
    expect(validatePaymentTerms({ type: 'net', netDays: 60 })).toBeNull();
    expect(validatePaymentTerms({ type: 'bogus' as any })).toMatch(/Unknown/);
  });
  it('overdue only while something is still owed', () => {
    const due = new Date('2026-01-01T00:00:00Z');
    expect(isOverdue(due, 10, new Date('2026-01-02T00:00:00Z'))).toBe(true);
    expect(isOverdue(due, 0, new Date('2026-01-02T00:00:00Z'))).toBe(false);
    expect(isOverdue(null, 10)).toBe(false);
  });
  it('keeps the balance exact across installments, ignores voided ones, refuses overpayment', () => {
    const pays = [{ amount: 33.33 }, { amount: 33.33 }, { amount: 10, voided: true }];
    expect(outstandingBalance(100, pays)).toBe(33.34);
    expect(paymentStatusOf(100, pays)).toBe('partial');
    expect(paymentStatusOf(100, [])).toBe('unpaid');
    expect(paymentStatusOf(100, [...pays, { amount: 33.34 }])).toBe('paid');
    expect(validateInstallment(33.35, 100, pays)).toMatch(/more than/);
    expect(validateInstallment(33.34, 100, pays)).toBeNull();
    expect(validateInstallment(0, 100, pays)).toMatch(/above 0/);
  });
  it('deposit and credit limit', () => {
    expect(depositRequired(200, 25)).toBe(50);
    expect(depositRequired(200, 0)).toBe(0);
    expect(creditLimitCheck(1000, 700, 300)).toEqual({ ok: true, available: 300 });
    expect(creditLimitCheck(1000, 700, 300.01)).toMatchObject({ ok: false });
    expect(creditLimitCheck(null, 99999, 1)).toEqual({ ok: true, available: null });
  });
});

describe('company vs location settings and roles', () => {
  it('location overrides the company field by field; empty method list falls back', () => {
    const company = { catalogId: 'c1', paymentTerms: { type: 'net' as const, netDays: 30 }, allowedPaymentMethods: ['bank_transfer'], creditLimit: 5000 };
    expect(effectiveCompanySettings(company, { catalogId: 'c2', allowedPaymentMethods: [] })).toEqual({ catalogId: 'c2', paymentTerms: company.paymentTerms, allowedPaymentMethods: ['bank_transfer'], creditLimit: 5000 });
    expect(effectiveCompanySettings(company, null).catalogId).toBe('c1');
  });
  it('payment method restriction', () => {
    expect(isPaymentMethodAllowed([], 'cash_on_delivery')).toBe(true);
    expect(isPaymentMethodAllowed(['bank_transfer'], 'cash_on_delivery')).toBe(false);
    expect(isPaymentMethodAllowed(['bank_transfer'], 'bank_transfer')).toBe(true);
  });
  it('only a location admin manages, and only their own location', () => {
    expect(canManageLocation('location_admin', 'L1', 'L1')).toBe(true);
    expect(canManageLocation('location_admin', 'L1', 'L2')).toBe(false);
    expect(canManageLocation('ordering', 'L1', 'L1')).toBe(false);
  });
});
