/* eslint-disable prettier/prettier */
/**
 * Cash-on-delivery protection (Pakistan RTO / fake-order control). Pure rules: no database access here.
 * Everything is store-scoped: the score uses only a customer's history WITH THIS STORE, never across stores.
 */

export interface CodSettings {
  enabled: boolean;
  /** COD is refused above this order total (store currency). null = no limit. */
  maxCodAmount: number | null;
  /** Ask the buyer to confirm a COD order when they have no delivered order with this store yet. */
  confirmNewCustomers: boolean;
  /** Ask for confirmation at or above this total. null = never for value. */
  confirmAboveAmount: number | null;
  /** Ask for confirmation when the delivery city is one of these (case-insensitive). */
  flaggedCities: string[];
  /** Normalised phone numbers (see normalizePhone) for which COD is refused. */
  blockedPhones: string[];
  /** Address fragments (normalised, >= 6 chars) for which COD is refused. */
  blockedAddresses: string[];
  /** Score from which an order counts as high risk. */
  highRiskScore: number;
  /** High-risk orders cannot use COD at all (card / transfer only). Off = they just need confirmation. */
  highRiskPrepayOnly: boolean;
  /** Hours the buyer has to confirm before the order is cancelled automatically. */
  confirmationHours: number;
}

export const DEFAULT_COD_SETTINGS: CodSettings = {
  enabled: false, maxCodAmount: null, confirmNewCustomers: true, confirmAboveAmount: null, flaggedCities: [], blockedPhones: [], blockedAddresses: [],
  highRiskScore: 60, highRiskPrepayOnly: false, confirmationHours: 24,
};

export interface CodHistory {
  delivered: number;
  cancelled: number;
  returned: number;
  rto: number;
}

export interface CodOrderContext {
  amount: number;
  city?: string | null;
  phone?: string | null;
  address?: string | null;
  history: CodHistory;
}

export type CodDecision = 'allow' | 'confirm' | 'block_cod';
export type CodRiskLevel = 'low' | 'medium' | 'high';

export interface CodReason { code: string; label: string; points: number }
export interface CodEvaluation { decision: CodDecision; score: number; level: CodRiskLevel; reasons: CodReason[]; phoneKey: string | null }

/**
 * One comparable key for a phone number. Pakistani formats (03xx..., +92 3xx..., 0092 3xx..., 3xx...) collapse to 92 + 10 digits; anything
 * else is its digits. null when there are fewer than 7 digits.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('92') && d.length === 12) return d;
  if (d.startsWith('0') && d.length === 11) return '92' + d.slice(1);
  if (d.startsWith('3') && d.length === 10) return '92' + d;
  return d.length >= 7 ? d : null;
}

export const normalizeAddress = (raw: unknown): string => (typeof raw === 'string' ? raw.toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim() : '');

const POINTS = { cancelled: 15, rto: 30, returned: 10, delivered: -5, deliveredCap: -25, newCustomer: 10, highValue: 15, flaggedCity: 10, blocked: 100 };

/** Risk score (0-100) from the store's own history plus the rule hits. */
export function scoreOrder(history: CodHistory, hits: { newCustomer: boolean; highValue: boolean; flaggedCity: boolean; blocked: boolean }): { score: number; reasons: CodReason[] } {
  const reasons: CodReason[] = [];
  const add = (code: string, label: string, points: number) => { if (points !== 0) reasons.push({ code, label, points }); };
  if (history.rto > 0) add('rto', `${history.rto} earlier order(s) came back undelivered (RTO)`, history.rto * POINTS.rto);
  if (history.cancelled > 0) add('cancelled', `${history.cancelled} earlier order(s) cancelled`, history.cancelled * POINTS.cancelled);
  if (history.returned > 0) add('returned', `${history.returned} earlier order(s) with returns`, history.returned * POINTS.returned);
  if (history.delivered > 0) add('delivered', `${history.delivered} earlier order(s) delivered`, Math.max(POINTS.deliveredCap, history.delivered * POINTS.delivered));
  if (hits.newCustomer) add('new_customer', 'First order with this store', POINTS.newCustomer);
  if (hits.highValue) add('high_value', 'High order value', POINTS.highValue);
  if (hits.flaggedCity) add('flagged_city', 'Delivery city flagged by the store', POINTS.flaggedCity);
  if (hits.blocked) add('blocked', 'Phone or address is on the store block list', POINTS.blocked);
  const score = Math.max(0, Math.min(100, reasons.reduce((s, r) => s + r.points, 0)));
  return { score, reasons };
}

export const levelOf = (score: number, highAt: number): CodRiskLevel => (score >= highAt ? 'high' : score >= Math.round(highAt / 2) ? 'medium' : 'low');

/** The decision for one COD order. Disabled settings always allow (and still score nothing). */
export function evaluateCodOrder(settings: CodSettings, ctx: CodOrderContext): CodEvaluation {
  const phoneKey = normalizePhone(ctx.phone);
  if (!settings.enabled) return { decision: 'allow', score: 0, level: 'low', reasons: [], phoneKey };

  const addr = normalizeAddress(ctx.address);
  const blocked = (!!phoneKey && settings.blockedPhones.includes(phoneKey)) || settings.blockedAddresses.some((a) => a.length >= 6 && addr.includes(a));
  const city = (ctx.city ?? '').trim().toLowerCase();
  const flaggedCity = !!city && settings.flaggedCities.some((c) => c.trim().toLowerCase() === city);
  const newCustomer = settings.confirmNewCustomers && ctx.history.delivered === 0;
  const highValue = settings.confirmAboveAmount != null && ctx.amount >= settings.confirmAboveAmount;
  const { score, reasons } = scoreOrder(ctx.history, { newCustomer, highValue, flaggedCity, blocked });
  const level = levelOf(score, settings.highRiskScore);

  if (blocked) return { decision: 'block_cod', score, level, reasons, phoneKey };
  if (settings.maxCodAmount != null && ctx.amount > settings.maxCodAmount) {
    return { decision: 'block_cod', score, level, reasons: [...reasons, { code: 'over_limit', label: `Above the COD limit of ${settings.maxCodAmount}`, points: 0 }], phoneKey };
  }
  if (score >= settings.highRiskScore && settings.highRiskPrepayOnly) return { decision: 'block_cod', score, level, reasons, phoneKey };
  if (newCustomer || highValue || flaggedCity || score >= settings.highRiskScore) return { decision: 'confirm', score, level, reasons, phoneKey };
  return { decision: 'allow', score, level, reasons, phoneKey };
}

/** Validates and cleans a settings update from the seller. Returns the clean value or an error text. */
export function cleanCodSettings(input: any, base: CodSettings): { ok: true; value: CodSettings } | { ok: false; error: string } {
  const v: CodSettings = { ...base };
  const num = (x: any, name: string, min: number, max: number, nullable: boolean): string | null => {
    if (x === null && nullable) return null;
    if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) throw new Error(`${name} must be a number between ${min} and ${max}`);
    return String(x);
  };
  try {
    if (input.enabled !== undefined) { if (typeof input.enabled !== 'boolean') throw new Error('enabled must be true or false'); v.enabled = input.enabled; }
    if (input.confirmNewCustomers !== undefined) { if (typeof input.confirmNewCustomers !== 'boolean') throw new Error('confirmNewCustomers must be true or false'); v.confirmNewCustomers = input.confirmNewCustomers; }
    if (input.highRiskPrepayOnly !== undefined) { if (typeof input.highRiskPrepayOnly !== 'boolean') throw new Error('highRiskPrepayOnly must be true or false'); v.highRiskPrepayOnly = input.highRiskPrepayOnly; }
    if (input.maxCodAmount !== undefined) { const r = num(input.maxCodAmount, 'maxCodAmount', 1, 1e9, true); v.maxCodAmount = r === null ? null : Number(r); }
    if (input.confirmAboveAmount !== undefined) { const r = num(input.confirmAboveAmount, 'confirmAboveAmount', 1, 1e9, true); v.confirmAboveAmount = r === null ? null : Number(r); }
    if (input.highRiskScore !== undefined) { num(input.highRiskScore, 'highRiskScore', 10, 100, false); v.highRiskScore = Math.round(input.highRiskScore); }
    if (input.confirmationHours !== undefined) { num(input.confirmationHours, 'confirmationHours', 1, 168, false); v.confirmationHours = Math.round(input.confirmationHours); }
    if (input.flaggedCities !== undefined) {
      if (!Array.isArray(input.flaggedCities) || input.flaggedCities.some((c: any) => typeof c !== 'string')) throw new Error('flaggedCities must be a list of text');
      v.flaggedCities = [...new Set((input.flaggedCities as string[]).map((c) => c.trim().slice(0, 60)).filter(Boolean))].slice(0, 200);
    }
    if (input.blockedPhones !== undefined) {
      if (!Array.isArray(input.blockedPhones) || input.blockedPhones.some((c: any) => typeof c !== 'string')) throw new Error('blockedPhones must be a list of text');
      const keys = (input.blockedPhones as string[]).map((p) => normalizePhone(p));
      if (keys.some((k) => !k)) throw new Error('A blocked phone number is not valid');
      v.blockedPhones = [...new Set(keys as string[])].slice(0, 1000);
    }
    if (input.blockedAddresses !== undefined) {
      if (!Array.isArray(input.blockedAddresses) || input.blockedAddresses.some((c: any) => typeof c !== 'string')) throw new Error('blockedAddresses must be a list of text');
      const cleaned = (input.blockedAddresses as string[]).map(normalizeAddress);
      if (cleaned.some((a) => a.length < 6)) throw new Error('A blocked address needs at least 6 characters');
      v.blockedAddresses = [...new Set(cleaned)].slice(0, 1000);
    }
  } catch (e: any) { return { ok: false, error: e.message }; }
  return { ok: true, value: v };
}
