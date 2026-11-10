/* eslint-disable prettier/prettier */
import { randomBytes } from 'crypto';

export const MAX_OPTIONS = 6;
export const MAX_GROUP_PRODUCTS = 200;
export const MAX_QTY = 99;
export const STOCK_FAILURES_BEFORE_PAUSE = 3;
export const REMINDER_DAYS = [3, 5];
export const PAUSE_AFTER_DAYS = 7;

type Unit = 'week' | 'month';
const UNITS: Unit[] = ['week', 'month'];

/** Adds `count` weeks/months to a date (month ends clamp: Jan 31 + 1 month = Feb 28/29). UTC. */
export function addInterval(from: Date, unit: Unit, count: number): Date {
  const d = new Date(from.getTime());
  if (unit === 'week') { d.setUTCDate(d.getUTCDate() + 7 * count); return d; }
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + count);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Unit price after the plan discount. */
export const discountedPrice = (price: number, discountPercent: number) => round2(price * (1 - Math.min(Math.max(discountPercent, 0), 90) / 100));

/** Approximate monthly value of one delivery (for the MRR-style report). Weeks count as 52/12 per month. */
export const monthlyFactor = (unit: Unit, count: number) => (unit === 'month' ? 1 / count : 52 / 12 / count);

export function eligible(group: { productIds: string[]; variantIds: string[]; status: string }, productId: string, variantId: string): boolean {
  return group.status === 'active' && group.productIds.includes(productId) && (group.variantIds.length === 0 || group.variantIds.includes(variantId));
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN);
const ids = (v: unknown, max: number): string[] | null => (Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && /^[a-f0-9]{24}$/i.test(x)) ? [...new Set(v as string[])] : null);

/** Validates a plan-group body (create = every field required, update = only given fields). Returns clean data or an error. */
export function validateGroup(body: any, partial: boolean): { ok: true; data: any } | { ok: false; error: string } {
  const data: any = {};
  if (body?.name !== undefined || !partial) { const n = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : ''; if (!n) return { ok: false, error: 'Name is required' }; data.name = n; }
  if (body?.options !== undefined || !partial) {
    const o = body?.options;
    if (!Array.isArray(o) || o.length < 1 || o.length > MAX_OPTIONS) return { ok: false, error: `Add 1 to ${MAX_OPTIONS} delivery frequencies` };
    const seen = new Set<string>(); const out: any[] = [];
    for (const x of o) {
      const count = num(x?.count); const disc = x?.discountPercent === undefined || x?.discountPercent === '' ? 0 : num(x.discountPercent);
      if (!UNITS.includes(x?.unit) || !Number.isInteger(count) || count < 1 || count > 12) return { ok: false, error: 'Each frequency needs week or month and a whole number 1-12' };
      if (!Number.isFinite(disc) || disc < 0 || disc > 90) return { ok: false, error: 'Discount must be between 0 and 90 percent' };
      const key = `${x.unit}:${count}`; if (seen.has(key)) return { ok: false, error: 'Two frequencies are the same' }; seen.add(key);
      const id = typeof x?.id === 'string' && /^[a-z0-9]{8,24}$/.test(x.id) ? x.id : randomBytes(6).toString('hex');
      const label = typeof x?.label === 'string' && x.label.trim() ? x.label.trim().slice(0, 60) : `Every ${count === 1 ? '' : count + ' '}${x.unit}${count === 1 ? '' : 's'}`;
      out.push({ id, label, unit: x.unit, count, discountPercent: disc });
    }
    data.options = out;
  }
  if (body?.trialDays !== undefined) { const t = num(body.trialDays); if (!Number.isInteger(t) || t < 0 || t > 90) return { ok: false, error: 'Trial days must be 0-90' }; data.trialDays = t; }
  if (body?.maxCycles !== undefined) { if (body.maxCycles === null || body.maxCycles === '') data.maxCycles = null; else { const m = num(body.maxCycles); if (!Number.isInteger(m) || m < 1 || m > 120) return { ok: false, error: 'Number of orders must be 1-120' }; data.maxCycles = m; } }
  if (body?.productIds !== undefined) { const p = ids(body.productIds, MAX_GROUP_PRODUCTS); if (!p) return { ok: false, error: 'Invalid product list' }; data.productIds = p; }
  if (body?.variantIds !== undefined) { const v = ids(body.variantIds, 500); if (!v) return { ok: false, error: 'Invalid variant list' }; data.variantIds = v; }
  if (body?.shippingAmount !== undefined) { const s = num(body.shippingAmount); if (!Number.isFinite(s) || s < 0 || s > 1_000_000) return { ok: false, error: 'Invalid shipping amount' }; data.shippingAmount = round2(s); }
  if (body?.taxPercent !== undefined) { const t = num(body.taxPercent); if (!Number.isFinite(t) || t < 0 || t > 50) return { ok: false, error: 'Tax must be 0-50 percent' }; data.taxPercent = t; }
  if (body?.status !== undefined) { if (!['active', 'archived'].includes(body.status)) return { ok: false, error: 'Unknown status' }; data.status = body.status; }
  return { ok: true, data };
}

/** Delivery address for a contract: only these fields, all text, bounded. */
export function cleanAddress(a: any): { recipientName: string; addressLine1: string; addressLine2?: string; city: string; state?: string; zipCode?: string; phoneNumber: string } | null {
  const s = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const out = { recipientName: s(a?.recipientName, 120), addressLine1: s(a?.addressLine1, 200), addressLine2: s(a?.addressLine2, 200) || undefined, city: s(a?.city, 80), state: s(a?.state, 80) || undefined, zipCode: s(a?.zipCode, 20) || undefined, phoneNumber: s(a?.phoneNumber ?? a?.phone, 40) };
  return out.recipientName && out.addressLine1 && out.city && out.phoneNumber ? out : null;
}
