import { computeStoreRisk } from './store-risk.util';

const now = new Date('2026-11-11T00:00:00Z');
const old = new Date('2025-01-01');
const base = { verificationStatus: 'verified', country: 'US', hasNtn: false, createdAt: old, now };
const codes = (r: ReturnType<typeof computeStoreRisk>) => r.reasons.map((x) => x.code);

describe('computeStoreRisk', () => {
  it('a verified, quiet, old store is low risk with no reasons', () => {
    expect(computeStoreRisk(base)).toEqual({ level: 'low', reasons: [] });
  });

  it('not verified = medium; high once the deadline passed', () => {
    expect(computeStoreRisk({ ...base, verificationStatus: 'pending' }).level).toBe('medium');
    const r = computeStoreRisk({ ...base, verificationStatus: 'pending', deadlinePassed: true });
    expect(r.level).toBe('high');
    expect(codes(r)).toEqual(['not_verified_overdue']);
  });

  it('PK store without NTN = medium; with NTN nothing', () => {
    expect(codes(computeStoreRisk({ ...base, country: 'PK' }))).toEqual(['missing_ntn']);
    expect(computeStoreRisk({ ...base, country: 'PK', hasNtn: true }).level).toBe('low');
  });

  it('regulated category without a product licence = high', () => {
    const r = computeStoreRisk({ ...base, businessProfile: { regulatedCategories: ['medicines'] } });
    expect(r.level).toBe('high');
    expect(codes(r)).toContain('regulated_without_licence');
    expect(computeStoreRisk({ ...base, businessProfile: { regulatedCategories: ['medicines'] }, documentTypes: ['product_licence'] }).level).toBe('low');
  });

  it('branded goods w/o authorization, dropship + no returns, bank not own name = medium each', () => {
    expect(computeStoreRisk({ ...base, businessProfile: { sellsBrandedGoods: true } }).level).toBe('medium');
    expect(computeStoreRisk({ ...base, businessProfile: { sellsBrandedGoods: true }, documentTypes: ['brand_authorization'] }).level).toBe('low');
    expect(codes(computeStoreRisk({ ...base, businessProfile: { sourcing: 'dropshipper', returnPolicy: 'no_returns' } }))).toEqual(['dropship_no_returns']);
    expect(computeStoreRisk({ ...base, businessProfile: { sourcing: 'dropshipper', returnPolicy: '7_day_returns' } }).level).toBe('low');
    expect(codes(computeStoreRisk({ ...base, businessProfile: { bankAccountInOwnName: false } }))).toEqual(['bank_not_own_name']);
  });

  it('a new store is only an info signal (does not raise the level)', () => {
    const r = computeStoreRisk({ ...base, createdAt: new Date(now.getTime() - 3 * 86400000) });
    expect(codes(r)).toEqual(['new_store']);
    expect(r.level).toBe('low');
  });

  it('refund rate >= 10% on >= 10 orders in 30 days = high', () => {
    expect(computeStoreRisk({ ...base, orders30d: 10, refunds30d: 1 }).level).toBe('high');
    expect(computeStoreRisk({ ...base, orders30d: 9, refunds30d: 5 }).level).toBe('low');
    expect(computeStoreRisk({ ...base, orders30d: 20, refunds30d: 1 }).level).toBe('low');
  });

  it('2+ open reports = high', () => {
    expect(computeStoreRisk({ ...base, openReports: 2 }).level).toBe('high');
    expect(computeStoreRisk({ ...base, openReports: 1 }).level).toBe('low');
  });

  it('7-day average order value over 3x the 30-day average (5+ orders) = medium', () => {
    expect(codes(computeStoreRisk({ ...base, orders30d: 20, avgOrderValue30d: 10, orders7d: 5, avgOrderValue7d: 31 }))).toEqual(['order_value_spike']);
    expect(computeStoreRisk({ ...base, orders30d: 20, avgOrderValue30d: 10, orders7d: 4, avgOrderValue7d: 31 }).level).toBe('low');
    expect(computeStoreRisk({ ...base, orders30d: 20, avgOrderValue30d: 10, orders7d: 5, avgOrderValue7d: 30 }).level).toBe('low');
  });

  it('level is the max severity', () => {
    const r = computeStoreRisk({ ...base, verificationStatus: 'pending', openReports: 3, createdAt: now });
    expect(r.level).toBe('high');
    expect(codes(r)).toEqual(['not_verified', 'new_store', 'open_reports']);
  });
});
