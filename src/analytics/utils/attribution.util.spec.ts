import { buildRows, dimensionKey, isAttributionModel, pickTouch, type Touch } from './attribution.util';

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);
const touch = (sessionId: string, at: number, trafficSource: string, extra: Partial<Touch> = {}): Touch => ({
  sessionId, visitorId: 'v1', startedAt: day(at), trafficSource, ...extra,
});

describe('pickTouch — which visit an order is credited to', () => {
  const email = touch('s1', 1, 'email', { utmCampaign: 'spring' });
  const social = touch('s2', 5, 'social');
  const direct = touch('s3', 9, 'direct');
  const history = [email, social, direct];

  it('last_click credits the converting visit, even when it was direct', () => {
    expect(pickTouch('last_click', direct, history, day(9)).sessionId).toBe('s3');
  });

  it('last_non_direct skips a direct converting visit and uses the latest earlier visit that came from somewhere', () => {
    expect(pickTouch('last_non_direct', direct, history, day(9)).sessionId).toBe('s2');
  });

  it('last_non_direct keeps the converting visit when it was not direct', () => {
    expect(pickTouch('last_non_direct', social, history, day(5)).sessionId).toBe('s2');
  });

  it('last_non_direct falls back to the converting (direct) visit when every visit was direct', () => {
    const d1 = touch('d1', 1, 'direct');
    const d2 = touch('d2', 3, 'direct');
    expect(pickTouch('last_non_direct', d2, [d1, d2], day(3)).sessionId).toBe('d2');
  });

  it('first_click credits the first visit inside the 30 day look-back', () => {
    expect(pickTouch('first_click', direct, history, day(9)).sessionId).toBe('s1');
  });

  it('visits older than 30 days before the order are ignored', () => {
    const old = touch('old', 0, 'paid');
    const late = touch('late', 45, 'direct');
    expect(pickTouch('first_click', late, [old, late], day(45)).sessionId).toBe('late');
    expect(pickTouch('last_non_direct', late, [old, late], day(45)).sessionId).toBe('late');
  });

  it('visits after the order do not count', () => {
    const after = touch('after', 12, 'social');
    expect(pickTouch('last_non_direct', direct, [direct, after], day(9)).sessionId).toBe('s3');
  });
});

describe('dimensionKey', () => {
  it('channel is the traffic type; source prefers the UTM source, then the referring site', () => {
    expect(dimensionKey('channel', { trafficSource: 'email' })).toBe('email');
    expect(dimensionKey('source', { trafficSource: 'social', utmSource: 'Instagram' })).toBe('instagram');
    expect(dimensionKey('source', { trafficSource: 'referral', referrerHost: 'Blog.Example.com' })).toBe('blog.example.com');
    expect(dimensionKey('source', { trafficSource: 'direct' })).toBe('direct');
  });
  it('campaign is only defined for visits that carried a campaign', () => {
    expect(dimensionKey('campaign', { trafficSource: 'email', utmCampaign: 'Spring' })).toBe('spring');
    expect(dimensionKey('campaign', { trafficSource: 'email' })).toBeNull();
  });
});

describe('buildRows', () => {
  it('combines sessions and credited sales, biggest sales first, with AOV and conversion rate', () => {
    const rows = buildRows(
      new Map([['email', 200], ['social', 50], ['direct', 400]]),
      [{ key: 'email', sales: 100 }, { key: 'email', sales: 50 }, { key: 'social', sales: 300 }],
    );
    expect(rows.map((r) => r.key)).toEqual(['social', 'email', 'direct']);
    expect(rows[1]).toMatchObject({ key: 'email', sessions: 200, orders: 2, sales: 150, averageOrderValue: 75, conversionRate: 1 });
    expect(rows[2]).toMatchObject({ key: 'direct', orders: 0, sales: 0, averageOrderValue: 0, conversionRate: 0 });
  });
  it('a key that only has orders (no sessions in range) still shows, with 0% conversion', () => {
    const rows = buildRows(new Map(), [{ key: 'paid', sales: 80 }]);
    expect(rows).toEqual([{ key: 'paid', sessions: 0, orders: 1, sales: 80, averageOrderValue: 80, conversionRate: 0 }]);
  });
});

describe('isAttributionModel', () => {
  it('accepts only the supported models', () => {
    expect(isAttributionModel('last_click')).toBe(true);
    expect(isAttributionModel('linear')).toBe(false);
    expect(isAttributionModel(undefined)).toBe(false);
  });
});
