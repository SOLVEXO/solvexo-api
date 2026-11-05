/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';

/**
 * Structured customer-segment filter (Shopify Segments parity) — a JSON tree, NEVER a free-text query.
 * `normalizeSegmentFilter` validates/whitelists everything the client sends; `compileSegmentFilter` turns the
 * normalized filter into a Mongo `$match` over the fields the store-customers pipeline computes. Client values are
 * only ever used as typed literals (finite numbers, valid dates, short strings, 24-hex ids) — a client can never inject
 * an operator, a field name or a `$where`.
 */
export const SEGMENT_COMBINATORS = ['and', 'or'] as const;
export type SegmentCombinator = (typeof SEGMENT_COMBINATORS)[number];
export const MAX_SEGMENT_CONDITIONS = 10;
const MAX_LIST_VALUES = 25;
const MAX_STRING = 80;

export type SegmentFieldType = 'number' | 'date' | 'tags' | 'text' | 'enum' | 'products';
/** Extra pipeline work a field needs (only done when a condition actually uses it). */
export type SegmentNeed = 'firstOrder' | 'location' | 'products' | 'storeCredit' | 'loyalty';

interface FieldDef { type: SegmentFieldType; key: string; ops: readonly string[]; enumValues?: readonly string[]; need?: SegmentNeed }

const NUMBER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'] as const;
const DATE_OPS = ['before', 'after', 'between', 'within_last_days', 'not_within_last_days', 'never'] as const;
const SET_OPS = ['has_any', 'has_all', 'has_none'] as const;
const TEXT_OPS = ['equals', 'not_equals', 'in'] as const;

export const SEGMENT_FIELDS: Record<string, FieldDef> = {
  amount_spent: { type: 'number', key: 'totalSpent', ops: NUMBER_OPS },
  order_count: { type: 'number', key: 'orderCount', ops: NUMBER_OPS },
  average_order_value: { type: 'number', key: 'avgOrderValue', ops: NUMBER_OPS },
  store_credit_balance: { type: 'number', key: 'storeCreditBalance', ops: NUMBER_OPS, need: 'storeCredit' },
  last_order_date: { type: 'date', key: 'lastOrderAt', ops: DATE_OPS },
  first_order_date: { type: 'date', key: 'firstOrderAt', ops: DATE_OPS, need: 'firstOrder' },
  tags: { type: 'tags', key: 'tags', ops: SET_OPS },
  country: { type: 'text', key: 'shipCountryLower', ops: TEXT_OPS, need: 'location' },
  city: { type: 'text', key: 'shipCityLower', ops: TEXT_OPS, need: 'location' },
  marketing_status: { type: 'enum', key: 'marketingStatus', ops: TEXT_OPS, enumValues: ['subscribed', 'pending', 'unsubscribed', 'not_subscribed'] },
  account_status: { type: 'enum', key: 'accountStatus', ops: TEXT_OPS, enumValues: ['account', 'guest', 'blocked'] },
  product_purchased: { type: 'products', key: 'purchasedProductIds', ops: SET_OPS, need: 'products' },
  loyalty_tier: { type: 'text', key: 'loyaltyTierLower', ops: TEXT_OPS, need: 'loyalty' },
};

export interface SegmentCondition { field: string; op: string; value?: unknown }
export interface SegmentFilter { combinator: SegmentCombinator; conditions: SegmentCondition[] }
export interface CompiledSegment { match: Record<string, any>; needs: Set<SegmentNeed> }

const bad = (msg: string): never => { throw new BadRequestException(msg); };
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function num(v: unknown, label: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e12) bad(`${label} must be a number`);
  return v as number;
}
function dateVal(v: unknown, label: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(v) || Number.isNaN(new Date(v).getTime())) bad(`${label} must be a valid date (YYYY-MM-DD)`);
  return v as string;
}
function strList(v: unknown, label: string, each: (s: string) => string): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_LIST_VALUES) bad(`${label} needs 1-${MAX_LIST_VALUES} values`);
  return (v as unknown[]).map((x) => {
    if (typeof x !== 'string') bad(`${label} values must be text`);
    const s = (x as string).trim();
    if (!s || s.length > MAX_STRING) bad(`${label} values must be 1-${MAX_STRING} characters`);
    return each(s);
  });
}

/** Validates + whitelists a client-supplied filter; throws 400 on anything unexpected. Returns a clean copy. */
export function normalizeSegmentFilter(raw: unknown): SegmentFilter {
  if (!isPlainObject(raw)) bad('filter must be an object');
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (k !== 'combinator' && k !== 'conditions') bad(`Unknown filter key "${k}"`);
  const combinator = (r.combinator ?? 'and') as SegmentCombinator;
  if (!SEGMENT_COMBINATORS.includes(combinator)) bad('combinator must be "and" or "or"');
  if (!Array.isArray(r.conditions) || r.conditions.length === 0) bad('Add at least one condition');
  const list = r.conditions as unknown[];
  if (list.length > MAX_SEGMENT_CONDITIONS) bad(`At most ${MAX_SEGMENT_CONDITIONS} conditions`);

  const conditions = list.map((c, i): SegmentCondition => {
    if (!isPlainObject(c)) return bad(`Condition ${i + 1} is invalid`);
    const cc = c as Record<string, unknown>;
    for (const k of Object.keys(cc)) if (k !== 'field' && k !== 'op' && k !== 'value') bad(`Unknown key "${k}" in condition ${i + 1}`);
    const field = cc.field;
    if (typeof field !== 'string' || !Object.prototype.hasOwnProperty.call(SEGMENT_FIELDS, field)) return bad(`Condition ${i + 1}: unknown field`);
    const def = SEGMENT_FIELDS[field as string];
    const op = cc.op;
    if (typeof op !== 'string' || !def.ops.includes(op)) return bad(`Condition ${i + 1}: "${String(op).slice(0, 30)}" is not allowed for ${field}`);
    return { field: field as string, op, value: normalizeValue(def, op, cc.value, `Condition ${i + 1}`) };
  });
  return { combinator, conditions };
}

function normalizeValue(def: FieldDef, op: string, value: unknown, label: string): unknown {
  if (def.type === 'number') {
    if (op === 'between') {
      if (!Array.isArray(value) || value.length !== 2) bad(`${label}: "between" needs two numbers`);
      const [a, b] = (value as unknown[]).map((x) => num(x, label));
      return a <= b ? [a, b] : [b, a];
    }
    return num(value, label);
  }
  if (def.type === 'date') {
    if (op === 'never') return undefined;
    if (op === 'within_last_days' || op === 'not_within_last_days') {
      const n = num(value, label);
      if (!Number.isInteger(n) || n < 1 || n > 3650) bad(`${label}: days must be a whole number between 1 and 3650`);
      return n;
    }
    if (op === 'between') {
      if (!Array.isArray(value) || value.length !== 2) bad(`${label}: "between" needs two dates`);
      const [a, b] = (value as unknown[]).map((x) => dateVal(x, label));
      return new Date(a) <= new Date(b) ? [a, b] : [b, a];
    }
    return dateVal(value, label);
  }
  if (def.type === 'tags') return strList(value, label, (s) => s);
  if (def.type === 'products') return strList(value, label, (s) => (/^[a-f\d]{24}$/i.test(s) ? s : bad(`${label}: invalid product id`)));
  // text / enum
  if (op === 'in') return strList(value, label, (s) => checkEnum(def, s, label));
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_STRING) bad(`${label}: a value is required`);
  return checkEnum(def, (value as string).trim(), label);
}
function checkEnum(def: FieldDef, s: string, label: string): string {
  if (def.enumValues && !def.enumValues.includes(s)) bad(`${label}: "${s.slice(0, 30)}" is not a valid option`);
  return def.type === 'text' ? s.toLowerCase() : s;
}

const DAY_MS = 86_400_000;

/** Compiles a NORMALIZED filter to a Mongo $match over the computed customer fields. `now` is injectable for tests. */
export function compileSegmentFilter(filter: SegmentFilter, now: Date = new Date()): CompiledSegment {
  const needs = new Set<SegmentNeed>();
  const parts = filter.conditions.map((c) => {
    const def = SEGMENT_FIELDS[c.field];
    if (def.need) needs.add(def.need);
    return compileCondition(def, c, now);
  });
  return { match: filter.combinator === 'or' ? { $or: parts } : { $and: parts }, needs };
}

function compileCondition(def: FieldDef, c: SegmentCondition, now: Date): Record<string, any> {
  const k = def.key;
  const v = c.value as any;
  switch (def.type) {
    case 'number':
      switch (c.op) {
        case 'eq': return { [k]: v };
        case 'neq': return { [k]: { $ne: v } };
        case 'gt': return { [k]: { $gt: v } };
        case 'gte': return { [k]: { $gte: v } };
        case 'lt': return { [k]: { $lt: v } };
        case 'lte': return { [k]: { $lte: v } };
        default: return { [k]: { $gte: v[0], $lte: v[1] } }; // between
      }
    case 'date':
      switch (c.op) {
        case 'before': return { [k]: { $lt: new Date(v) } };
        case 'after': return { [k]: { $gt: new Date(v) } };
        case 'between': return { [k]: { $gte: new Date(v[0]), $lte: new Date(v[1]) } };
        case 'within_last_days': return { [k]: { $gte: new Date(now.getTime() - v * DAY_MS) } };
        // Customers who never ordered count as "not within the last N days".
        case 'not_within_last_days': return { $or: [{ [k]: null }, { [k]: { $lt: new Date(now.getTime() - v * DAY_MS) } }] };
        default: return { [k]: null }; // never
      }
    case 'tags':
    case 'products':
      if (c.op === 'has_any') return { [k]: { $in: v } };
      if (c.op === 'has_all') return { [k]: { $all: v } };
      return { [k]: { $nin: v } };
    default: // text / enum
      if (c.op === 'equals') return { [k]: v };
      if (c.op === 'not_equals') return { [k]: { $ne: v } };
      return { [k]: { $in: v } };
  }
}
