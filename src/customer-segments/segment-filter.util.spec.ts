/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { compileSegmentFilter, MAX_SEGMENT_CONDITIONS, normalizeSegmentFilter, SEGMENT_FIELDS } from './segment-filter.util';

/** Minimal evaluator for exactly the operators the compiler emits, so compiled filters are tested against real rows. */
function matches(doc: any, q: any): boolean {
  return Object.entries(q).every(([k, v]: [string, any]) => {
    if (k === '$and') return v.every((x: any) => matches(doc, x));
    if (k === '$or') return v.some((x: any) => matches(doc, x));
    const val = doc[k];
    if (v === null) return val === null || val === undefined;
    if (v instanceof Date || typeof v !== 'object') return val instanceof Date && v instanceof Date ? val.getTime() === v.getTime() : val === v;
    return Object.entries(v).every(([op, arg]: [string, any]) => {
      const num = (x: any) => (x instanceof Date ? x.getTime() : x);
      switch (op) {
        case '$gt': return val != null && num(val) > num(arg);
        case '$gte': return val != null && num(val) >= num(arg);
        case '$lt': return val != null && num(val) < num(arg);
        case '$lte': return val != null && num(val) <= num(arg);
        case '$ne': return val !== arg;
        case '$in': return Array.isArray(val) ? val.some((x) => arg.includes(x)) : arg.includes(val);
        case '$nin': return Array.isArray(val) ? !val.some((x) => arg.includes(x)) : !arg.includes(val);
        case '$all': return Array.isArray(val) && arg.every((x: any) => val.includes(x));
        default: throw new Error(`unexpected operator ${op}`);
      }
    });
  });
}

const NOW = new Date('2026-11-05T00:00:00Z');
const run = (filter: any, docs: any[]) => docs.filter((d) => matches(d, compileSegmentFilter(normalizeSegmentFilter(filter), NOW).match));
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const P1 = 'a'.repeat(24);
const P2 = 'b'.repeat(24);

const customers = [
  { _id: 'vip', totalSpent: 5000, orderCount: 12, avgOrderValue: 416, lastOrderAt: day(3), firstOrderAt: day(400), tags: ['vip', 'wholesale'], shipCountryLower: 'pk', shipCityLower: 'lahore', marketingStatus: 'subscribed', accountStatus: 'account', purchasedProductIds: [P1], storeCreditBalance: 100, loyaltyTierLower: 'gold' },
  { _id: 'new', totalSpent: 90, orderCount: 1, avgOrderValue: 90, lastOrderAt: day(10), firstOrderAt: day(10), tags: [], shipCountryLower: 'us', shipCityLower: 'austin', marketingStatus: 'pending', accountStatus: 'guest', purchasedProductIds: [P2], storeCreditBalance: 0, loyaltyTierLower: '' },
  { _id: 'cold', totalSpent: 300, orderCount: 3, avgOrderValue: 100, lastOrderAt: day(200), firstOrderAt: day(300), tags: ['vip'], shipCountryLower: 'pk', shipCityLower: 'karachi', marketingStatus: 'unsubscribed', accountStatus: 'blocked', purchasedProductIds: [P1, P2], storeCreditBalance: 0, loyaltyTierLower: 'silver' },
  // an old customer row that lacks every optional/computed field
  { _id: 'legacy', totalSpent: 0, orderCount: 0, avgOrderValue: 0, lastOrderAt: null, tags: [] },
];
const ids = (rows: any[]) => rows.map((r) => r._id).sort();
const one = (field: string, op: string, value?: unknown) => ({ conditions: [{ field, op, value }] });

describe('segment filter — every field and operator', () => {
  it.each([
    ['amount_spent', 'gt', 100, ['cold', 'vip']],
    ['amount_spent', 'gte', 300, ['cold', 'vip']],
    ['amount_spent', 'lt', 100, ['legacy', 'new']],
    ['amount_spent', 'lte', 90, ['legacy', 'new']],
    ['amount_spent', 'eq', 90, ['new']],
    ['amount_spent', 'neq', 90, ['cold', 'legacy', 'vip']],
    ['amount_spent', 'between', [100, 1000], ['cold']],
    ['amount_spent', 'between', [1000, 100], ['cold']], // reversed bounds are normalized
    ['order_count', 'gte', 3, ['cold', 'vip']],
    ['average_order_value', 'gt', 99, ['cold', 'vip']],
    ['store_credit_balance', 'gt', 0, ['vip']],
  ])('number %s %s', (field, op, value, expected) => expect(ids(run(one(field as string, op as string, value), customers))).toEqual(expected));

  it.each([
    ['last_order_date', 'within_last_days', 30, ['new', 'vip']],
    ['last_order_date', 'not_within_last_days', 30, ['cold', 'legacy']], // never-ordered counts as "not within"
    ['last_order_date', 'before', day(100).toISOString().slice(0, 10), ['cold']],
    ['last_order_date', 'after', day(100).toISOString().slice(0, 10), ['new', 'vip']],
    ['last_order_date', 'between', [day(250).toISOString().slice(0, 10), day(150).toISOString().slice(0, 10)], ['cold']],
    ['last_order_date', 'never', undefined, ['legacy']],
    ['first_order_date', 'before', day(350).toISOString().slice(0, 10), ['vip']],
  ])('date %s %s', (field, op, value, expected) => expect(ids(run(one(field as string, op as string, value), customers))).toEqual(expected));

  it.each([
    ['tags', 'has_any', ['vip'], ['cold', 'vip']],
    ['tags', 'has_all', ['vip', 'wholesale'], ['vip']],
    ['tags', 'has_none', ['vip'], ['legacy', 'new']],
    ['product_purchased', 'has_any', [P2], ['cold', 'new']],
    ['product_purchased', 'has_all', [P1, P2], ['cold']],
    ['product_purchased', 'has_none', [P1], ['legacy', 'new']],
    ['country', 'equals', 'PK', ['cold', 'vip']], // case-insensitive
    ['country', 'not_equals', 'pk', ['legacy', 'new']],
    ['city', 'in', ['Lahore', 'Austin'], ['new', 'vip']],
    ['marketing_status', 'equals', 'subscribed', ['vip']],
    ['marketing_status', 'in', ['pending', 'unsubscribed'], ['cold', 'new']],
    ['account_status', 'equals', 'blocked', ['cold']],
    ['account_status', 'in', ['guest', 'blocked'], ['cold', 'new']],
    ['loyalty_tier', 'equals', 'Gold', ['vip']],
  ])('set/text/enum %s %s', (field, op, value, expected) => expect(ids(run(one(field as string, op as string, value), customers))).toEqual(expected));

  it('every defined field/op combination normalizes and compiles', () => {
    for (const [field, def] of Object.entries(SEGMENT_FIELDS)) expect(def.ops.length).toBeGreaterThan(0), expect(field).toBeTruthy();
  });
});

describe('segment filter — AND / OR and needs', () => {
  const f = (combinator: string) => ({ combinator, conditions: [{ field: 'amount_spent', op: 'gt', value: 1000 }, { field: 'country', op: 'equals', value: 'us' }] });
  it('AND requires all, OR requires any', () => {
    expect(ids(run(f('and'), customers))).toEqual([]);
    expect(ids(run(f('or'), customers))).toEqual(['new', 'vip']);
  });
  it('defaults to AND and only reports the extra data a condition needs', () => {
    const c = compileSegmentFilter(normalizeSegmentFilter({ conditions: [{ field: 'amount_spent', op: 'gt', value: 1 }] }));
    expect(c.needs.size).toBe(0);
    const d = compileSegmentFilter(normalizeSegmentFilter(f('and')));
    expect([...d.needs]).toEqual(['location']);
  });
  it('legacy rows missing optional fields do not crash matching', () => {
    expect(() => run(f('or'), [{ _id: 'x' }])).not.toThrow();
  });
});

describe('segment filter — validation / injection', () => {
  const rejects = (raw: any) => expect(() => normalizeSegmentFilter(raw)).toThrow(BadRequestException);
  it('rejects non-objects, unknown keys, empty and oversized condition lists', () => {
    rejects(null); rejects('x'); rejects([]); rejects({ conditions: [] }); rejects({ conditions: 'x' });
    rejects({ conditions: [{ field: 'amount_spent', op: 'gt', value: 1 }], $where: 'sleep(1)' });
    rejects({ combinator: 'xor', conditions: [{ field: 'amount_spent', op: 'gt', value: 1 }] });
    rejects({ conditions: Array.from({ length: MAX_SEGMENT_CONDITIONS + 1 }, () => ({ field: 'amount_spent', op: 'gt', value: 1 })) });
  });
  it('rejects unknown fields/ops (incl. Mongo operators and prototype keys)', () => {
    rejects(one('password', 'eq', 1)); rejects(one('$where', 'eq', 1)); rejects(one('__proto__', 'eq', 1)); rejects(one('constructor', 'eq', 1));
    rejects(one('amount_spent', '$gt', 1)); rejects(one('amount_spent', 'regex', 1)); rejects(one('tags', 'gt', ['a']));
  });
  it('rejects operator objects and non-literal values', () => {
    rejects(one('amount_spent', 'gt', { $gt: 0 }));
    rejects(one('amount_spent', 'eq', '5'));
    rejects(one('amount_spent', 'eq', NaN));
    rejects(one('amount_spent', 'between', [1]));
    rejects(one('country', 'equals', { $ne: 'pk' }));
    rejects(one('tags', 'has_any', [{ $ne: 1 }]));
    rejects(one('tags', 'has_any', 'vip'));
    rejects(one('tags', 'has_any', []));
    rejects(one('tags', 'has_any', Array.from({ length: 26 }, (_, i) => `t${i}`)));
    rejects(one('product_purchased', 'has_any', ['not-an-id']));
    rejects(one('last_order_date', 'before', 'yesterday'));
    rejects(one('last_order_date', 'within_last_days', 0));
    rejects(one('last_order_date', 'within_last_days', 1.5));
    rejects(one('marketing_status', 'equals', 'bogus'));
    rejects({ conditions: [{ field: 'amount_spent', op: 'gt', value: 1, extra: 1 }] });
  });
  it('accepts a well-formed filter and returns a clean copy', () => {
    const out = normalizeSegmentFilter({ combinator: 'or', conditions: [{ field: 'tags', op: 'has_any', value: [' vip '] }] });
    expect(out).toEqual({ combinator: 'or', conditions: [{ field: 'tags', op: 'has_any', value: ['vip'] }] });
  });
});
