/* eslint-disable prettier/prettier */
import { createHash } from 'crypto';
import type { ExperimentKind } from './experiment.schema';

export const MAX_EXPERIMENTS_PER_STORE = 10;
export const MAX_RUNNING = 3;
export const MAX_OVERRIDES = 20;
export const MIN_VISITS_PER_VARIANT = 100;
export const MIN_TOTAL_CONVERSIONS = 10;

const ID = /^[A-Za-z0-9_-]{8,64}$/;
export const isAnalyticsId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

/** Uniform number in [0,100) from a hash of the parts: stable for the same experiment + visitor, no personal data. */
export function bucket(experimentId: string, visitorId: string, salt: string): number {
  const h = createHash('sha256').update(`${salt}:${experimentId}:${visitorId}`).digest();
  return (h.readUInt32BE(0) / 0x1_0000_0000) * 100;
}

/** Which variant (if any) a visitor sees. Traffic share and split use separate hashes, so changing one never reshuffles the other. */
export function assignVariant(experimentId: string, visitorId: string, trafficPercent: number, splitB: number): 'a' | 'b' | null {
  if (bucket(experimentId, visitorId, 'enter') >= trafficPercent) return null;
  return bucket(experimentId, visitorId, 'split') < splitB ? 'b' : 'a';
}

const SIMPLE_KEY = /^[A-Za-z][A-Za-z0-9_.]{0,59}$/;
// Keys that would change structure or reach other data, never allowed as overrides.
const BLOCKED_KEYS = new Set(['_id', 'id', 'type', 'enabled', 'blocks', 'colorSchemeId', 'customCss', 'customHtml', 'html', 'script']);

type Ok<T> = { ok: true; data: T }; type Err = { ok: false; error: string };

/** Plain values only: <=20 keys, strings <=500 chars with no markup, numbers, booleans. */
export function cleanOverrides(kind: ExperimentKind, input: unknown): Ok<Record<string, string | number | boolean>> | Err {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Add at least one change for variant B' };
  const out: Record<string, string | number | boolean> = {};
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, error: 'Add at least one change for variant B' };
  if (entries.length > MAX_OVERRIDES) return { ok: false, error: `At most ${MAX_OVERRIDES} changes` };
  for (const [k, v] of entries) {
    if (!SIMPLE_KEY.test(k) || BLOCKED_KEYS.has(k) || k.includes('__') || k.startsWith('$')) return { ok: false, error: `"${k}" cannot be changed in a test` };
    if (kind === 'theme_settings' && !k.startsWith('custom.')) return { ok: false, error: 'Theme tests can only change theme settings that start with custom.' };
    if (kind === 'section' && k.includes('.')) return { ok: false, error: `"${k}" is not a section setting` };
    if (typeof v === 'string') {
      if (v.length > 500 || /[<>]/.test(v)) return { ok: false, error: `The value of "${k}" is too long or contains markup` };
      out[k] = v;
    } else if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e9) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else return { ok: false, error: `The value of "${k}" must be text, a number or yes/no` };
  }
  return { ok: true, data: out };
}

export function validateExperiment(body: any, kind?: ExperimentKind): Ok<any> | Err {
  const data: any = {};
  const k: ExperimentKind | undefined = kind ?? body?.kind;
  if (kind === undefined) { if (!['section', 'theme_settings'].includes(body?.kind)) return { ok: false, error: 'Choose what to test' }; data.kind = body.kind; }
  if (body?.name !== undefined || kind === undefined) { const n = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : ''; if (!n) return { ok: false, error: 'Name is required' }; data.name = n; }
  const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (body?.trafficPercent !== undefined) { const t = num(body.trafficPercent); if (!Number.isInteger(t) || t < 1 || t > 100) return { ok: false, error: 'Traffic must be a whole number 1-100' }; data.trafficPercent = t; }
  if (body?.splitB !== undefined) { const s = num(body.splitB); if (!Number.isInteger(s) || s < 1 || s > 99) return { ok: false, error: 'The split must be a whole number 1-99' }; data.splitB = s; }
  if (k === 'section' && (body?.sectionId !== undefined || kind === undefined)) { const s = typeof body?.sectionId === 'string' ? body.sectionId.trim() : ''; if (!/^[a-f0-9]{24}$/i.test(s)) return { ok: false, error: 'Choose the section to test' }; data.sectionId = s; }
  if (body?.variantBName !== undefined) data.variantBName = typeof body.variantBName === 'string' ? body.variantBName.trim().slice(0, 80) : '';
  if (body?.overrides !== undefined || kind === undefined) { const o = cleanOverrides(k as ExperimentKind, body?.overrides); if (!o.ok) return o; data.overrides = o.data; }
  return { ok: true, data };
}

export interface VariantCounts { visits: number; addedToCart: number; reachedCheckout: number; orders: number }

/** Two-proportion z-test of `b` against `a`. */
export function zTest(a: { n: number; x: number }, b: { n: number; x: number }): { z: number; p: number } | null {
  if (a.n <= 0 || b.n <= 0) return null;
  const p1 = a.x / a.n; const p2 = b.x / b.n; const pool = (a.x + b.x) / (a.n + b.n);
  const se = Math.sqrt(pool * (1 - pool) * (1 / a.n + 1 / b.n));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p2 - p1) / se;
  // two-sided p from the normal CDF (Abramowitz-Stegun 7.1.26 erf approximation)
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return { z, p: Math.max(0, Math.min(1, 1 - erf)) };
}

export type Verdict = 'not_enough_data' | 'inconclusive' | 'leaning' | 'likely';

/** Plain-language verdict on conversion: needs >=100 visits per variant and >=10 orders in total before it says anything. */
export function verdict(a: VariantCounts, b: VariantCounts): { verdict: Verdict; z: number | null; p: number | null; leader: 'a' | 'b' | null } {
  if (a.visits < MIN_VISITS_PER_VARIANT || b.visits < MIN_VISITS_PER_VARIANT || a.orders + b.orders < MIN_TOTAL_CONVERSIONS) return { verdict: 'not_enough_data', z: null, p: null, leader: null };
  const t = zTest({ n: a.visits, x: a.orders }, { n: b.visits, x: b.orders });
  if (!t) return { verdict: 'not_enough_data', z: null, p: null, leader: null };
  const leader = t.z > 0 ? 'b' : t.z < 0 ? 'a' : null;
  return { verdict: t.p < 0.05 ? 'likely' : t.p < 0.2 ? 'leaning' : 'inconclusive', z: Math.round(t.z * 100) / 100, p: Math.round(t.p * 1000) / 1000, leader };
}
