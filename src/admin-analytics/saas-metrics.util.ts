/* eslint-disable prettier/prettier */

/**
 * SaaS metrics for Solvexo's own revenue: what stores pay Solvexo for their platform plan (SellerPlatformSubscription).
 * Pure functions only, so every number is unit-tested. The service feeds them data.
 *
 * Vocabulary (the industry-standard definitions, as used by ChartMogul / Baremetrics / Stripe):
 *  - MRR: monthly recurring revenue; a yearly plan counts as amount / 12. Trials, free plans and $0 rows are 0.
 *  - A store "pays" at a moment when its MRR is > 0 then.
 *  - Movement between two moments, per store: new (first time it ever pays), reactivation (paid before, then
 *    stopped, now pays again), expansion / contraction (pays more / less), churn (paid, now doesn't).
 *  - NRR (net revenue retention): of the stores paying at the start, their MRR at the end / their MRR at the start.
 *    New and reactivated stores are excluded, so it shows growth from existing customers only.
 */

export type Interval = 'monthly' | 'yearly';
export type StoreMrrMap = Map<string, { mrr: number; planId: string | null }>;

export interface PlanInfo { isFree?: boolean; monthlyPriceUSD?: number | null; yearlyPriceUSD?: number | null; gracePeriodDays?: number | null }

export interface SubRow {
  storeId: string;
  status: string;
  platformPlanId: string | null;
  amountUSD: number;
  billingInterval?: string | null;
  startedAt: Date | string;
  trialEndsAt?: Date | string | null;
  canceledAt?: Date | string | null;
  lockedAt?: Date | string | null;
  gracePeriodEndsAt?: Date | string | null;
  updatedAt?: Date | string | null;
  planHistory?: Array<{ fromPlanId: string | null; toPlanId: string; changedAt: Date | string; amountUSD?: number; interval?: string }>;
}

export const DEFAULT_GRACE_DAYS = 7;
const DAY = 86_400_000;

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const toMonthly = (amount: number, interval?: string | null) => (interval === 'yearly' ? amount / 12 : amount);
const t = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : NaN);

/** Live MRR of one subscription right now: the same rule as the existing Overview / Billing MRR. */
export function liveStoreMrr(sub: SubRow): number {
  if (!['active', 'past_due'].includes(sub.status) || !(sub.amountUSD > 0)) return 0;
  return toMonthly(sub.amountUSD, sub.billingInterval);
}

export function liveMrrMap(subs: SubRow[]): StoreMrrMap {
  const map: StoreMrrMap = new Map();
  for (const s of subs) {
    const mrr = liveStoreMrr(s);
    if (mrr > 0) map.set(String(s.storeId), { mrr: round2(mrr), planId: s.platformPlanId ?? null });
  }
  return map;
}

/** The ordered plan segments of a subscription: which plan, at what monthly price, from when. */
function segments(sub: SubRow, plans: Map<string, PlanInfo>) {
  const history = [...(sub.planHistory ?? [])].sort((a, b) => t(a.changedAt) - t(b.changedAt));
  const priceOf = (planId: string | null, interval?: string | null) => {
    const p = planId ? plans.get(String(planId)) : undefined;
    if (!p || p.isFree) return 0;
    if (interval === 'yearly') return (p.yearlyPriceUSD ?? (p.monthlyPriceUSD ?? 0) * 12) / 12;
    return p.monthlyPriceUSD ?? 0;
  };
  const isFree = (planId: string | null) => !planId || !!plans.get(String(planId))?.isFree;
  const segs: Array<{ from: number; planId: string | null; mrr: number }> = [];

  // Before the first recorded change: the plan the subscription started on (none while trialing).
  const initialPlan = history.length ? history[0].fromPlanId : sub.platformPlanId;
  const trialed = !!sub.trialEndsAt;
  segs.push({
    from: t(sub.startedAt),
    planId: initialPlan,
    mrr: trialed && !initialPlan ? 0
      : history.length === 0 ? (isFree(initialPlan) ? 0 : toMonthly(sub.amountUSD, sub.billingInterval))
      : priceOf(initialPlan, sub.billingInterval),
  });
  history.forEach((h, i) => {
    const isLast = i === history.length - 1;
    // The current plan's exact amount is on the subscription; older ones use what the entry recorded, or the plan price.
    const mrr = isFree(h.toPlanId) ? 0
      : isLast && String(h.toPlanId) === String(sub.platformPlanId) ? toMonthly(sub.amountUSD, sub.billingInterval)
      : typeof h.amountUSD === 'number' ? toMonthly(h.amountUSD, h.interval ?? sub.billingInterval)
      : priceOf(h.toPlanId, h.interval ?? sub.billingInterval);
    segs.push({ from: t(h.changedAt), planId: h.toPlanId, mrr });
  });
  return segs;
}

/** When paid revenue stopped for good (as far as the record shows), or null while it continues. */
export function paidEndedAt(sub: SubRow, plans: Map<string, PlanInfo>): number | null {
  if (sub.status === 'canceled') return t(sub.canceledAt ?? sub.updatedAt) || null;
  if (sub.status === 'trial_ended') return t(sub.trialEndsAt ?? sub.updatedAt) || null;
  if (sub.status === 'locked') {
    if (sub.lockedAt) return t(sub.lockedAt);
    const grace = (sub.platformPlanId ? plans.get(String(sub.platformPlanId))?.gracePeriodDays : null) ?? DEFAULT_GRACE_DAYS;
    if (sub.gracePeriodEndsAt) return t(sub.gracePeriodEndsAt) - grace * DAY;
    return t(sub.updatedAt) || null;
  }
  return null;
}

/** First moment the store ever paid (MRR > 0), or null if it never has. */
export function firstPaidAt(sub: SubRow, plans: Map<string, PlanInfo>): number | null {
  const paid = segments(sub, plans).find((s) => s.mrr > 0);
  if (!paid) return null;
  const end = paidEndedAt(sub, plans);
  return end !== null && end <= paid.from ? null : paid.from;
}

/**
 * MRR of one subscription at a past moment, rebuilt from its record (start, plan changes, cancel / lock time).
 * Can't see a lapse that was later reactivated (the record only keeps the latest state); the daily snapshots fill
 * that gap from the day they start.
 */
export function reconstructStoreMrrAt(sub: SubRow, at: number, plans: Map<string, PlanInfo>): { mrr: number; planId: string | null } | null {
  if (at < t(sub.startedAt)) return null;
  const end = paidEndedAt(sub, plans);
  if (end !== null && at >= end) return null;
  if (sub.status === 'trialing') return null;
  const segs = segments(sub, plans);
  let current = segs[0];
  for (const s of segs) if (s.from <= at) current = s;
  return current.mrr > 0 ? { mrr: round2(current.mrr), planId: current.planId } : null;
}

export function reconstructMrrMapAt(subs: SubRow[], at: number, plans: Map<string, PlanInfo>): StoreMrrMap {
  const map: StoreMrrMap = new Map();
  for (const s of subs) {
    const r = reconstructStoreMrrAt(s, at, plans);
    if (r) map.set(String(s.storeId), r);
  }
  return map;
}

export const totalMrr = (m: StoreMrrMap) => round2([...m.values()].reduce((sum, v) => sum + v.mrr, 0));

export interface Movement {
  startMrr: number; endMrr: number; startStores: number; endStores: number;
  newMrr: number; expansionMrr: number; contractionMrr: number; churnedMrr: number; reactivationMrr: number; netNewMrr: number;
  newStores: number; churnedStores: number; reactivatedStores: number; expandedStores: number; contractedStores: number;
  /** Net revenue retention of the stores paying at the start, %. Null when nobody paid at the start. */
  nrrPercent: number | null;
  /** Gross revenue retention (no expansion), %. */
  grrPercent: number | null;
  logoChurnPercent: number | null;
  revenueChurnPercent: number | null;
  /** (new + expansion + reactivation) / (churn + contraction). Null when nothing was lost. */
  quickRatio: number | null;
}

/** Splits the change between two MRR maps into new / expansion / contraction / churn / reactivation. */
export function movementBetween(start: StoreMrrMap, end: StoreMrrMap, paidBefore: (storeId: string) => boolean): Movement {
  let newMrr = 0, expansionMrr = 0, contractionMrr = 0, churnedMrr = 0, reactivationMrr = 0;
  let newStores = 0, churnedStores = 0, reactivatedStores = 0, expandedStores = 0, contractedStores = 0;
  for (const [id, s] of start) {
    const e = end.get(id);
    if (!e) { churnedMrr += s.mrr; churnedStores++; continue; }
    if (e.mrr > s.mrr) { expansionMrr += e.mrr - s.mrr; expandedStores++; }
    else if (e.mrr < s.mrr) { contractionMrr += s.mrr - e.mrr; contractedStores++; }
  }
  for (const [id, e] of end) {
    if (start.has(id)) continue;
    if (paidBefore(id)) { reactivationMrr += e.mrr; reactivatedStores++; } else { newMrr += e.mrr; newStores++; }
  }
  const startMrr = totalMrr(start);
  const pct = (n: number, d: number) => (d > 0 ? round2((n / d) * 100) : null);
  const lost = churnedMrr + contractionMrr;
  return {
    startMrr, endMrr: totalMrr(end), startStores: start.size, endStores: end.size,
    newMrr: round2(newMrr), expansionMrr: round2(expansionMrr), contractionMrr: round2(contractionMrr),
    churnedMrr: round2(churnedMrr), reactivationMrr: round2(reactivationMrr),
    netNewMrr: round2(newMrr + expansionMrr + reactivationMrr - contractionMrr - churnedMrr),
    newStores, churnedStores, reactivatedStores, expandedStores, contractedStores,
    nrrPercent: pct(startMrr + expansionMrr - contractionMrr - churnedMrr, startMrr),
    grrPercent: pct(startMrr - contractionMrr - churnedMrr, startMrr),
    logoChurnPercent: pct(churnedStores, start.size),
    revenueChurnPercent: pct(churnedMrr + contractionMrr, startMrr),
    quickRatio: lost > 0 ? round2((newMrr + expansionMrr + reactivationMrr) / lost) : null,
  };
}

/**
 * Customer lifetime value = ARPU / average monthly logo churn, over the months given (weighted by store count).
 * Null with no churn yet: dividing by ~0 would print a meaningless huge number.
 */
export function lifetimeValue(arpu: number, months: Array<{ churnedStores: number; startStores: number }>) {
  const churned = months.reduce((s, m) => s + m.churnedStores, 0);
  const base = months.reduce((s, m) => s + m.startStores, 0);
  const monthlyChurn = base > 0 ? churned / base : 0;
  return {
    avgMonthlyLogoChurnPercent: base > 0 ? round2(monthlyChurn * 100) : null,
    ltv: monthlyChurn > 0 ? round2(arpu / monthlyChurn) : null,
    expectedLifetimeMonths: monthlyChurn > 0 ? round2(1 / monthlyChurn) : null,
  };
}

/** 'YYYY-MM' (UTC) */
export const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7);
/** Last millisecond of the UTC month that `ms` is in. */
export const endOfMonth = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1; };
/** End of each of the last `n` months, oldest first; the current month's point is `now`. */
export function monthPoints(n: number, now: number): number[] {
  const d = new Date(now);
  const pts: number[] = [];
  for (let i = n - 1; i >= 1; i--) pts.push(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i + 1, 1) - 1);
  pts.push(now);
  return pts;
}

export interface CohortRow { cohort: string; stores: number; startMrr: number; retention: Array<{ month: number; storesPercent: number; revenuePercent: number | null }> }

/**
 * Cohorts by the month a store first paid. `points` are month-end MRR maps keyed by month ('YYYY-MM'); month 0 is the
 * cohort's own month-end. storesPercent = cohort stores still paying; revenuePercent = their MRR vs month 0 (can be > 100).
 */
export function cohorts(firstPaid: Map<string, number>, points: Array<{ month: string; map: StoreMrrMap }>): CohortRow[] {
  const byCohort = new Map<string, string[]>();
  for (const [storeId, at] of firstPaid) {
    const key = monthKey(at);
    byCohort.set(key, [...(byCohort.get(key) ?? []), storeId]);
  }
  const idx = new Map(points.map((p, i) => [p.month, i]));
  const rows: CohortRow[] = [];
  for (const [cohort, stores] of [...byCohort].sort(([a], [b]) => a.localeCompare(b))) {
    const start = idx.get(cohort);
    if (start === undefined) continue; // older than the window shown
    const startMrr = round2(stores.reduce((s, id) => s + (points[start].map.get(id)?.mrr ?? 0), 0));
    const retention = points.slice(start).map((p, i) => {
      const paying = stores.filter((id) => p.map.has(id));
      const mrr = paying.reduce((s, id) => s + (p.map.get(id)?.mrr ?? 0), 0);
      return { month: i, storesPercent: round2((paying.length / stores.length) * 100), revenuePercent: startMrr > 0 ? round2((mrr / startMrr) * 100) : null };
    });
    rows.push({ cohort, stores: stores.length, startMrr, retention });
  }
  return rows;
}

export interface TrialRow { month: string; started: number; converted: number; stillTrialing: number; conversionPercent: number | null; avgDaysToConvert: number | null }

/** Trial → paid, by the month the trial started. Conversion is counted against trials that have finished (not still running). */
export function trialFunnel(subs: SubRow[], plans: Map<string, PlanInfo>, months: string[]): TrialRow[] {
  const rows = new Map(months.map((m) => [m, { month: m, started: 0, converted: 0, stillTrialing: 0, days: [] as number[] }]));
  for (const s of subs) {
    if (!s.trialEndsAt) continue; // never trialed (legacy / directly paid)
    const row = rows.get(monthKey(t(s.startedAt)));
    if (!row) continue;
    row.started++;
    const paid = firstPaidAt(s, plans);
    if (paid !== null) { row.converted++; row.days.push(Math.max(0, (paid - t(s.startedAt)) / DAY)); }
    else if (s.status === 'trialing') row.stillTrialing++;
  }
  return [...rows.values()].map((r) => {
    const decided = r.started - r.stillTrialing;
    return {
      month: r.month, started: r.started, converted: r.converted, stillTrialing: r.stillTrialing,
      conversionPercent: decided > 0 ? round2((r.converted / decided) * 100) : null,
      avgDaysToConvert: r.days.length ? round2(r.days.reduce((a, b) => a + b, 0) / r.days.length) : null,
    };
  });
}
