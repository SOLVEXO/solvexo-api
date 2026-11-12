/* eslint-disable prettier/prettier */
import { cleanCodSettings, DEFAULT_COD_SETTINGS, evaluateCodOrder, normalizeAddress, normalizePhone, scoreOrder, type CodSettings } from './cod-risk.util';

const on = (over: Partial<CodSettings> = {}): CodSettings => ({ ...DEFAULT_COD_SETTINGS, enabled: true, ...over });
const none = { delivered: 0, cancelled: 0, returned: 0, rto: 0 };
const ctx = (over: any = {}) => ({ amount: 1000, city: 'Lahore', phone: '0300 1234567', address: 'House 5, Street 2', history: { ...none, delivered: 2 }, ...over });

describe('normalizePhone', () => {
  it('collapses Pakistani formats to one key', () => {
    for (const p of ['03001234567', '0300-1234567', '+92 300 1234567', '0092 300 1234567', '3001234567', '923001234567']) expect(normalizePhone(p)).toBe('923001234567');
  });
  it('keeps other countries as digits and rejects junk', () => {
    expect(normalizePhone('+1 (415) 555-2671')).toBe('14155552671');
    expect(normalizePhone('12')).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
});

describe('evaluateCodOrder rules matrix', () => {
  it('disabled settings always allow', () => {
    expect(evaluateCodOrder(DEFAULT_COD_SETTINGS, ctx({ amount: 1e9, history: { ...none, rto: 5 } })).decision).toBe('allow');
  });
  it('a repeat customer with a clean history is allowed', () => {
    expect(evaluateCodOrder(on(), ctx())).toMatchObject({ decision: 'allow', level: 'low' });
  });
  it('max COD amount blocks COD (not equal, above)', () => {
    expect(evaluateCodOrder(on({ maxCodAmount: 1000 }), ctx({ amount: 1000 })).decision).toBe('allow');
    expect(evaluateCodOrder(on({ maxCodAmount: 1000 }), ctx({ amount: 1001 }))).toMatchObject({ decision: 'block_cod' });
  });
  it('blocked phone (any format) and blocked address fragment block COD', () => {
    expect(evaluateCodOrder(on({ blockedPhones: ['923001234567'] }), ctx({ phone: '+92-300-1234567' })).decision).toBe('block_cod');
    expect(evaluateCodOrder(on({ blockedAddresses: ['street 2'] }), ctx({ address: 'House 5, STREET-2, DHA' })).decision).toBe('block_cod');
    expect(evaluateCodOrder(on({ blockedAddresses: ['street 22'] }), ctx({ address: 'House 5, Street 2' })).decision).toBe('allow');
  });
  it('new customer, high value and flagged city each require confirmation', () => {
    expect(evaluateCodOrder(on(), ctx({ history: none })).decision).toBe('confirm');
    expect(evaluateCodOrder(on({ confirmNewCustomers: false }), ctx({ history: none })).decision).toBe('allow');
    expect(evaluateCodOrder(on({ confirmAboveAmount: 500 }), ctx()).decision).toBe('confirm');
    expect(evaluateCodOrder(on({ flaggedCities: ['lahore'] }), ctx()).decision).toBe('confirm');
  });
  it('history: RTO and cancellations raise the score; high score confirms, or blocks COD when prepay-only is on', () => {
    const bad = ctx({ history: { delivered: 0, cancelled: 2, returned: 0, rto: 1 } });
    const e = evaluateCodOrder(on({ confirmNewCustomers: false }), bad);
    expect(e.score).toBeGreaterThanOrEqual(60);
    expect(e).toMatchObject({ decision: 'confirm', level: 'high' });
    expect(evaluateCodOrder(on({ confirmNewCustomers: false, highRiskPrepayOnly: true }), bad).decision).toBe('block_cod');
  });
  it('deliveries lower the score but never below zero or by more than 25', () => {
    expect(scoreOrder({ delivered: 50, cancelled: 0, returned: 0, rto: 0 }, { newCustomer: false, highValue: false, flaggedCity: false, blocked: false }).score).toBe(0);
    const s = scoreOrder({ delivered: 50, cancelled: 2, returned: 0, rto: 0 }, { newCustomer: false, highValue: false, flaggedCity: false, blocked: false });
    expect(s.score).toBe(30 - 25);
  });
  it('the score is capped at 100 and a block-list hit is explained', () => {
    const e = evaluateCodOrder(on({ blockedPhones: ['923001234567'] }), ctx({ history: { delivered: 0, cancelled: 9, returned: 9, rto: 9 } }));
    expect(e.score).toBe(100);
    expect(e.reasons.some((r) => r.code === 'blocked')).toBe(true);
  });
});

describe('cleanCodSettings', () => {
  it('accepts valid changes, normalises phones/addresses and de-duplicates', () => {
    const r: any = cleanCodSettings({ enabled: true, maxCodAmount: 50000, blockedPhones: ['0300-1234567', '+923001234567'], blockedAddresses: ['House #5, Street-2'], flaggedCities: [' Karachi ', 'Karachi'], confirmationHours: 12 }, DEFAULT_COD_SETTINGS);
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ enabled: true, maxCodAmount: 50000, blockedPhones: ['923001234567'], blockedAddresses: ['house 5 street 2'], flaggedCities: ['Karachi'], confirmationHours: 12 });
  });
  it('rejects wrong types, ranges, bad phones and short addresses, and never touches unknown fields', () => {
    for (const bad of [{ enabled: 'yes' }, { maxCodAmount: -1 }, { confirmationHours: 0 }, { confirmationHours: 500 }, { highRiskScore: 5 }, { blockedPhones: ['12'] }, { blockedAddresses: ['abc'] }, { flaggedCities: 'x' }, { blockedPhones: [{ $gt: '' }] }]) {
      expect((cleanCodSettings(bad, DEFAULT_COD_SETTINGS) as any).ok).toBe(false);
    }
    const r: any = cleanCodSettings({ storeId: 'x', isAdmin: true, maxCodAmount: null }, { ...DEFAULT_COD_SETTINGS, maxCodAmount: 5 });
    expect(r.value.maxCodAmount).toBeNull();
    expect(r.value.storeId).toBeUndefined();
  });
  it('address normalisation ignores punctuation and case', () => {
    expect(normalizeAddress('House #5, Street-2!')).toBe('house 5 street 2');
  });
});
