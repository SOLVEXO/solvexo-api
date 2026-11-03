/* eslint-disable prettier/prettier */

/**
 * Merchant activation funnel: how far each new merchant (Seller) gets after signing up.
 *   signed_up → verified (email) → store (first store) → product (first product) → sale (first order) → paying (first plan)
 * A merchant is counted at a step when that step AND every step before it are reached (the usual funnel definition:
 * each step is a subset of the previous one, so e.g. a plan bought before any sale doesn't count as "Paying" until
 * the first sale). Verified has no date of its own: it's a flag. Pure functions; the service collects the dates.
 */

export const FUNNEL_STEPS = ['signed_up', 'verified', 'store', 'product', 'sale', 'paying'] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
export const STEP_LABEL: Record<FunnelStep, string> = {
  signed_up: 'Signed up', verified: 'Verified email', store: 'Created a store', product: 'Added a product', sale: 'First sale', paying: 'Paying plan',
};

export interface MerchantJourney {
  sellerId: string; name: string | null; email: string | null; source: string | null;
  signedUpAt: number; verified: boolean;
  storeAt: number | null; productAt: number | null; saleAt: number | null; paidAt: number | null;
}

const DAY = 86_400_000;
const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (n: number, d: number) => (d > 0 ? r1((n / d) * 100) : null);
export const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/** When a step was reached (verified uses the sign-up time: the flag has no date of its own), or null. */
export function reachedAt(m: MerchantJourney, step: FunnelStep): number | null {
  switch (step) {
    case 'signed_up': return m.signedUpAt;
    case 'verified': return m.verified ? m.signedUpAt : null;
    case 'store': return m.storeAt;
    case 'product': return m.productAt;
    case 'sale': return m.saleAt;
    case 'paying': return m.paidAt;
  }
}

/** Funnel membership: the step AND every step before it reached (so each step is a subset of the one before). */
export function reachedInOrder(m: MerchantJourney, step: FunnelStep): boolean {
  return FUNNEL_STEPS.slice(0, FUNNEL_STEPS.indexOf(step) + 1).every((s) => reachedAt(m, s) !== null);
}

/** The furthest step in order with every step before it reached. */
export function furthestStep(m: MerchantJourney): FunnelStep {
  let last: FunnelStep = 'signed_up';
  for (const s of FUNNEL_STEPS) { if (reachedAt(m, s) === null) break; last = s; }
  return last;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return r1(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
};

export interface FunnelStepRow { step: FunnelStep; label: string; merchants: number; percentOfSignups: number | null; percentOfPrevious: number | null; medianDaysFromSignup: number | null }

export function funnel(ms: MerchantJourney[]): FunnelStepRow[] {
  let prev = ms.length;
  return FUNNEL_STEPS.map((step) => {
    const reached = ms.filter((m) => reachedInOrder(m, step));
    const row = {
      step, label: STEP_LABEL[step], merchants: reached.length,
      percentOfSignups: pct(reached.length, ms.length), percentOfPrevious: step === 'signed_up' ? null : pct(reached.length, prev),
      medianDaysFromSignup: step === 'signed_up' || step === 'verified' ? null : median(reached.map((m) => Math.max(0, (reachedAt(m, step)! - m.signedUpAt) / DAY))),
    };
    prev = reached.length;
    return row;
  });
}

export interface CohortFunnelRow { month: string; signups: number; percent: Record<FunnelStep, number | null> }

export function funnelByCohort(ms: MerchantJourney[], months: string[]): CohortFunnelRow[] {
  return months.map((month) => {
    const c = ms.filter((m) => monthOf(m.signedUpAt) === month);
    return { month, signups: c.length, percent: Object.fromEntries(FUNNEL_STEPS.map((s) => [s, pct(c.filter((m) => reachedInOrder(m, s)).length, c.length)])) as Record<FunnelStep, number | null> };
  });
}

export interface SourceRow { source: string; signups: number; storePercent: number | null; salePercent: number | null; payingPercent: number | null }

/** By sign-up channel (Seller.acquisitionSource), biggest first; unknown sources group under "Direct / unknown". */
export function funnelBySource(ms: MerchantJourney[]): SourceRow[] {
  const groups = new Map<string, MerchantJourney[]>();
  for (const m of ms) {
    const key = m.source?.trim() || 'Direct / unknown';
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return [...groups].map(([source, g]) => ({
    source, signups: g.length,
    storePercent: pct(g.filter((m) => reachedInOrder(m, 'store')).length, g.length),
    salePercent: pct(g.filter((m) => reachedInOrder(m, 'sale')).length, g.length),
    payingPercent: pct(g.filter((m) => reachedInOrder(m, 'paying')).length, g.length),
  })).sort((a, b) => b.signups - a.signups);
}

export interface StuckMerchant { sellerId: string; name: string | null; email: string | null; stuckAt: FunnelStep; nextStep: FunnelStep; daysStuck: number; signedUpDaysAgo: number }

/**
 * Recent merchants (signed up in the last `withinDays`) who reached a step but not the next one for at least
 * `minDays`: the outreach list. Paying merchants are done; most days stuck first.
 */
export function stuckMerchants(ms: MerchantJourney[], now: number, withinDays = 60, minDays = 3): StuckMerchant[] {
  const out: StuckMerchant[] = [];
  for (const m of ms) {
    if (now - m.signedUpAt > withinDays * DAY) continue;
    const at = furthestStep(m);
    if (at === 'paying') continue;
    const next = FUNNEL_STEPS[FUNNEL_STEPS.indexOf(at) + 1];
    const since = reachedAt(m, at)!;
    const daysStuck = Math.floor((now - since) / DAY);
    if (daysStuck < minDays) continue;
    out.push({ sellerId: m.sellerId, name: m.name, email: m.email, stuckAt: at, nextStep: next, daysStuck, signedUpDaysAgo: Math.floor((now - m.signedUpAt) / DAY) });
  }
  return out.sort((a, b) => b.daysStuck - a.daysStuck);
}
