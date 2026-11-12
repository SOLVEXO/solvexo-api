/* eslint-disable prettier/prettier */
/**
 * Checkout rules ("Functions-lite"): declarative JSON only, evaluated on the SERVER. Nothing here executes user code:
 * fields, operators and actions are whitelisted, values are plain strings/numbers/booleans.
 */
export const RULE_TYPES = ['discount', 'payment', 'shipping', 'validation'] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const MAX_RULES_PER_STORE = 50;
export const MAX_CONDITIONS = 8;
export const MAX_LIST = 20;

type FieldKind = 'number' | 'string' | 'set' | 'boolean';
/** Field -> kind, and whether it is known only once the delivery address is (discount rules may not use those). */
export const FIELDS: Record<string, { kind: FieldKind; address?: boolean }> = {
  subtotal: { kind: 'number' }, itemCount: { kind: 'number' }, lineCount: { kind: 'number' }, maxLineQuantity: { kind: 'number' },
  country: { kind: 'string', address: true }, city: { kind: 'string', address: true }, state: { kind: 'string', address: true }, postalCode: { kind: 'string', address: true },
  productIds: { kind: 'set' }, customerTags: { kind: 'set' },
  isB2B: { kind: 'boolean' }, isGuest: { kind: 'boolean' }, hasDigital: { kind: 'boolean' }, hasPhysical: { kind: 'boolean' },
};
const OPS: Record<FieldKind, string[]> = {
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  string: ['eq', 'neq', 'in', 'not_in', 'starts_with'],
  set: ['contains', 'not_contains', 'contains_any'],
  boolean: ['eq'],
};

export interface RuleCondition { field: string; op: string; value: string | number | boolean | string[] }
export interface RuleLike { _id?: any; name: string; type: RuleType; status: 'active' | 'draft'; priority: number; conditions: RuleCondition[]; action: any }

/** What a rule can look at. Missing address parts are null: a condition on an unknown value never matches. */
export interface RuleContext {
  subtotal: number; itemCount: number; lineCount: number; maxLineQuantity: number;
  lines: { productId: string; quantity: number; total: number }[];
  productIds: string[]; customerTags: string[]; isB2B: boolean; isGuest: boolean; hasDigital: boolean; hasPhysical: boolean;
  country: string | null; city: string | null; state: string | null; postalCode: string | null;
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
const isOidList = (v: unknown, max: number) => Array.isArray(v) && v.length >= 1 && v.length <= max && v.every((x) => typeof x === 'string' && /^[a-f0-9]{24}$/i.test(x));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN);

type Ok<T> = { ok: true; data: T }; type Err = { ok: false; error: string };

export function validateCondition(c: any, type: RuleType): Ok<RuleCondition> | Err {
  const f = FIELDS[c?.field];
  if (!f) return { ok: false, error: 'Unknown condition field' };
  if (type === 'discount' && f.address) return { ok: false, error: 'Discount rules cannot use address fields (the address is not known yet)' };
  if (!OPS[f.kind].includes(c?.op)) return { ok: false, error: `Operator not allowed for ${c.field}` };
  let value: any = c.value;
  if (f.kind === 'number') { value = num(value); if (!Number.isFinite(value) || value < -1e9 || value > 1e9) return { ok: false, error: 'Enter a number' }; }
  else if (f.kind === 'boolean') { if (typeof value !== 'boolean') return { ok: false, error: 'Choose yes or no' }; }
  else {
    const listOp = c.op === 'in' || c.op === 'not_in' || c.op === 'contains_any';
    if (listOp) {
      if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LIST || value.some((x: unknown) => typeof x !== 'string' || !x.trim() || x.length > 100)) return { ok: false, error: `Give 1 to ${MAX_LIST} values` };
      value = [...new Set(value.map((x: string) => x.trim()))];
    } else {
      if (typeof value !== 'string' || !value.trim() || value.length > 100) return { ok: false, error: 'Enter a value' };
      value = value.trim();
    }
    if (c.field === 'productIds' && !(Array.isArray(value) ? value : [value]).every((x: string) => /^[a-f0-9]{24}$/i.test(x))) return { ok: false, error: 'Invalid product' };
  }
  return { ok: true, data: { field: c.field, op: c.op, value } };
}

export function validateAction(type: RuleType, a: any): Ok<any> | Err {
  const msg = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
  if (type === 'discount') {
    const kind = a?.kind; const value = num(a?.value);
    if (!['percent', 'fixed'].includes(kind)) return { ok: false, error: 'Choose percent or fixed discount' };
    if (!Number.isFinite(value) || value <= 0 || (kind === 'percent' && value > 100) || value > 1e9) return { ok: false, error: kind === 'percent' ? 'Percent must be above 0 and at most 100' : 'Enter an amount above 0' };
    const appliesTo = a?.appliesTo === 'products' ? 'products' : 'order';
    if (appliesTo === 'products' && !isOidList(a?.productIds, 50)) return { ok: false, error: 'Choose 1 to 50 products' };
    return { ok: true, data: { kind, value, appliesTo, productIds: appliesTo === 'products' ? [...new Set<string>(a.productIds)] : [], exclusive: a?.exclusive !== false, label: msg(a?.label).slice(0, 60) || 'Discount' } };
  }
  if (type === 'payment') {
    if (!['hide', 'show_only'].includes(a?.mode)) return { ok: false, error: 'Choose hide or show only' };
    const m = a?.methods;
    if (!Array.isArray(m) || m.length < 1 || m.length > 10 || m.some((x: unknown) => typeof x !== 'string' || !/^[a-z0-9_:-]{2,60}$/i.test(x))) return { ok: false, error: 'Choose 1 to 10 payment methods' };
    return { ok: true, data: { mode: a.mode, methods: [...new Set<string>(m.map((x: string) => x.toLowerCase()))] } };
  }
  if (type === 'shipping') {
    if (!['hide', 'rename', 'reorder'].includes(a?.mode)) return { ok: false, error: 'Choose hide, rename or move to top' };
    const zoneIds = a?.zoneIds === undefined || (Array.isArray(a.zoneIds) && a.zoneIds.length === 0) ? [] : isOidList(a.zoneIds, 20) ? [...new Set<string>(a.zoneIds)] : null;
    if (zoneIds === null) return { ok: false, error: 'Invalid shipping methods' };
    const zoneType = a?.zoneType === undefined || a.zoneType === null || a.zoneType === '' ? null : ['shipping', 'local_delivery', 'pickup'].includes(a.zoneType) ? a.zoneType : undefined;
    if (zoneType === undefined) return { ok: false, error: 'Unknown shipping type' };
    if (!zoneIds.length && !zoneType) return { ok: false, error: 'Choose which shipping methods this applies to' };
    let newName = '';
    if (a.mode === 'rename') { newName = msg(a?.newName).slice(0, 60); if (!newName) return { ok: false, error: 'Enter the new name' }; if (zoneIds.length === 0) return { ok: false, error: 'Renaming needs specific shipping methods' }; }
    return { ok: true, data: { mode: a.mode, zoneIds, zoneType, newName } };
  }
  const message = msg(a?.message); if (!message) return { ok: false, error: 'Enter the message the customer will see' };
  return { ok: true, data: { message } };
}

/** Validates a whole rule body (create = all required; update = only given fields, `type` can never change). */
export function validateRule(body: any, partial: boolean, existingType?: RuleType): Ok<any> | Err {
  const data: any = {};
  const type: RuleType | undefined = existingType ?? body?.type;
  if (!partial || body?.type !== undefined) { if (!(RULE_TYPES as readonly string[]).includes(body?.type)) return { ok: false, error: 'Unknown rule type' }; if (existingType && body.type !== existingType) return { ok: false, error: 'The type of a rule cannot change' }; data.type = body.type; }
  if (!partial || body?.name !== undefined) { const n = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : ''; if (!n) return { ok: false, error: 'Name is required' }; data.name = n; }
  if (body?.status !== undefined) { if (!['active', 'draft'].includes(body.status)) return { ok: false, error: 'Unknown status' }; data.status = body.status; }
  if (body?.priority !== undefined) { const p = num(body.priority); if (!Number.isInteger(p) || p < 0 || p > 1000) return { ok: false, error: 'Priority must be a whole number 0-1000' }; data.priority = p; }
  if (!partial || body?.conditions !== undefined) {
    const c = body?.conditions ?? [];
    if (!Array.isArray(c) || c.length > MAX_CONDITIONS) return { ok: false, error: `At most ${MAX_CONDITIONS} conditions` };
    const out: RuleCondition[] = [];
    for (const x of c) { const v = validateCondition(x, type as RuleType); if (!v.ok) return v; out.push(v.data); }
    data.conditions = out;
  }
  if (!partial || body?.action !== undefined) { const a = validateAction(type as RuleType, body?.action); if (!a.ok) return a; data.action = a.data; }
  return { ok: true, data };
}

function matchCondition(c: RuleCondition, ctx: RuleContext): boolean {
  const f = FIELDS[c.field]; if (!f) return false;
  const v = (ctx as any)[c.field];
  if (v === null || v === undefined) return false; // unknown address part: never matches
  if (f.kind === 'number') { const n = Number(c.value); return c.op === 'eq' ? v === n : c.op === 'neq' ? v !== n : c.op === 'gt' ? v > n : c.op === 'gte' ? v >= n : c.op === 'lt' ? v < n : v <= n; }
  if (f.kind === 'boolean') return v === c.value;
  if (f.kind === 'string') {
    const s = norm(v); const list = Array.isArray(c.value) ? c.value.map(norm) : [norm(c.value)];
    return c.op === 'eq' ? s === list[0] : c.op === 'neq' ? s !== list[0] : c.op === 'in' ? list.includes(s) : c.op === 'not_in' ? !list.includes(s) : s.startsWith(list[0]);
  }
  const have = new Set((v as string[]).map(norm)); const want = (Array.isArray(c.value) ? c.value : [c.value]).map(norm);
  return c.op === 'contains' ? have.has(want[0]) : c.op === 'not_contains' ? !have.has(want[0]) : want.some((w) => have.has(w));
}

const byPriority = (a: RuleLike, b: RuleLike) => a.priority - b.priority || String(a._id ?? a.name).localeCompare(String(b._id ?? b.name));
const matched = (rules: RuleLike[], type: RuleType, ctx: RuleContext) => rules.filter((r) => r.status === 'active' && r.type === type && r.conditions.every((c) => matchCondition(c, ctx))).sort(byPriority);
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface DiscountResult { total: number; applied: { ruleId: string; name: string; label: string; amount: number; productIds: string[] }[] }
export interface ShippingZoneLike { _id: any; name?: string; zoneType?: string; [k: string]: any }

export interface Evaluation {
  discount: DiscountResult;
  payment: { hidden: string[]; showOnly: string[] | null };
  shipping: { hideIds: string[]; hideTypes: string[]; renames: { ids: string[]; name: string }[]; top: { ids: string[]; type: string | null }[] };
  blocks: { ruleId: string; name: string; message: string }[];
}

/** One pass over the store's rules for this context. Order: priority ascending, ties by id. */
export function evaluateRules(rules: RuleLike[], ctx: RuleContext): Evaluation {
  const discount: DiscountResult = { total: 0, applied: [] };
  for (const r of matched(rules, 'discount', ctx)) {
    const a = r.action;
    const lines = a.appliesTo === 'products' ? ctx.lines.filter((l) => (a.productIds as string[]).includes(l.productId)) : ctx.lines;
    const base = round2(lines.reduce((s, l) => s + l.total, 0));
    if (base <= 0) continue;
    const room = round2(ctx.subtotal - discount.total);
    const amount = Math.min(a.kind === 'percent' ? round2(base * a.value / 100) : Math.min(a.value, base), room);
    if (amount <= 0) continue;
    discount.applied.push({ ruleId: String(r._id ?? ''), name: r.name, label: a.label, amount, productIds: a.appliesTo === 'products' ? lines.map((l) => l.productId) : [] });
    discount.total = round2(discount.total + amount);
    if (a.exclusive) break; // an exclusive rule ends the discount phase: the first matching one wins
  }
  const hidden = new Set<string>(); let showOnly: Set<string> | null = null;
  for (const r of matched(rules, 'payment', ctx)) {
    if (r.action.mode === 'hide') r.action.methods.forEach((m: string) => hidden.add(m));
    else { const s = new Set<string>(r.action.methods); showOnly = showOnly ? new Set([...showOnly].filter((m) => s.has(m))) : s; }
  }
  const shipping: Evaluation['shipping'] = { hideIds: [], hideTypes: [], renames: [], top: [] };
  for (const r of matched(rules, 'shipping', ctx)) {
    const a = r.action;
    if (a.mode === 'hide') { shipping.hideIds.push(...a.zoneIds); if (a.zoneType) shipping.hideTypes.push(a.zoneType); }
    else if (a.mode === 'rename') shipping.renames.push({ ids: a.zoneIds, name: a.newName });
    else shipping.top.push({ ids: a.zoneIds, type: a.zoneType });
  }
  const blocks = matched(rules, 'validation', ctx).map((r) => ({ ruleId: String(r._id ?? ''), name: r.name, message: r.action.message }));
  return { discount, payment: { hidden: [...hidden], showOnly: showOnly ? [...showOnly] : null }, shipping, blocks };
}

/** Payment methods after the rules. Hide beats show-only. No fail-open here: the same function decides what is offered and what is accepted, so they can never disagree (the seller test tool shows the result). */
export function filterPaymentMethods<T extends string>(methods: T[], ev: Evaluation, keyOf: (m: T) => string = (m) => m): { methods: T[] } {
  const hide = new Set(ev.payment.hidden); const only = ev.payment.showOnly ? new Set(ev.payment.showOnly) : null;
  return { methods: methods.filter((m) => { const k = keyOf(m).toLowerCase(); return !hide.has(k) && (!only || only.has(k)); }) };
}

export function shippingZoneHidden(z: ShippingZoneLike, ev: Evaluation): boolean {
  return ev.shipping.hideIds.includes(String(z._id)) || (!!z.zoneType && ev.shipping.hideTypes.includes(z.zoneType));
}

/** Hide / rename / move to top. If everything would be hidden the hide rules are ignored (never leave the buyer without delivery). */
export function applyShippingRules<T extends ShippingZoneLike>(zones: T[], ev: Evaluation): { zones: T[]; ignored: boolean } {
  let list = zones.filter((z) => !shippingZoneHidden(z, ev));
  const ignored = list.length === 0 && zones.length > 0;
  if (ignored) list = [...zones];
  list = list.map((z) => { const r = ev.shipping.renames.find((x) => x.ids.includes(String(z._id))); return r ? { ...z, name: r.name } : z; });
  // Earlier (higher priority) rules end up first: apply in reverse so the first rule's matches land on top.
  for (const t of [...ev.shipping.top].reverse()) {
    const isTop = (z: T) => t.ids.includes(String(z._id)) || (!!t.type && z.zoneType === t.type);
    list = [...list.filter(isTop), ...list.filter((z) => !isTop(z))];
  }
  return { zones: list, ignored };
}
