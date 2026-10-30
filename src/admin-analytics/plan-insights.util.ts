/* eslint-disable prettier/prettier */
import {
  type PlanInfo, type SubRow, liveStoreMrr, monthKey, planSegments, reconstructMrrMapAt, round2, toMonthly,
} from './saas-metrics.util';

/**
 * Plan and pricing insights: how each platform plan sells, which way stores move between plans, what they really pay
 * against today's list price, and which stores have outgrown their plan. Pure functions; PlanInsightsService feeds them.
 *
 * A plan move is any change in a store's plan record (SellerPlatformSubscription.planHistory), valued at monthly price:
 *  - new: from no paid plan (trial or free) to a paid one;
 *  - upgrade / downgrade: to a plan worth more / less per month (a move to a free plan is a downgrade);
 *  - interval: same plan, monthly ↔ yearly;
 *  - lateral: a different plan at the same monthly price.
 */

export type MoveKind = 'new' | 'upgrade' | 'downgrade' | 'interval' | 'lateral';

export interface PlanRecord extends PlanInfo {
  _id: string; name: string; status?: string; isPubliclyVisible?: boolean; isCustomPricing?: boolean; sortOrder?: number;
  trialDays?: number; limits?: { maxProducts?: number; transactionFeeRate?: number } | null;
}

export interface InsightSub extends SubRow {
  cancelAtPeriodEnd?: boolean;
  scheduledPlanChange?: { planId: string; planName?: string; interval?: string; amountUSD: number } | null;
}

export interface PlanMove { storeId: string; at: number; fromPlanId: string | null; toPlanId: string | null; fromMrr: number; toMrr: number; kind: MoveKind }

const pct = (n: number, d: number) => (d > 0 ? round2((n / d) * 100) : null);

/** Every plan change on one subscription, oldest first. */
export function planMoves(sub: SubRow, plans: Map<string, PlanInfo>): PlanMove[] {
  const segs = planSegments(sub, plans);
  const moves: PlanMove[] = [];
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1], b = segs[i];
    const from = round2(a.mrr), to = round2(b.mrr);
    let kind: MoveKind;
    if (from <= 0 && to <= 0) continue; // trial → free plan and the like: no money either side
    if (from <= 0) kind = 'new';
    else if (String(a.planId) === String(b.planId)) kind = 'interval';
    else if (to > from) kind = 'upgrade';
    else if (to < from) kind = 'downgrade';
    else kind = 'lateral';
    moves.push({ storeId: String(sub.storeId), at: b.from, fromPlanId: a.planId ?? null, toPlanId: b.planId ?? null, fromMrr: from, toMrr: to, kind });
  }
  return moves;
}

/** Today's list price of a plan for an interval, per month. Null for free / custom-priced / unpriced plans. */
export function listMonthly(p: PlanRecord | undefined, interval?: string | null): number | null {
  if (!p || p.isFree || p.isCustomPricing) return null;
  if (interval === 'yearly') return p.yearlyPriceUSD ? p.yearlyPriceUSD / 12 : null;
  return p.monthlyPriceUSD ? p.monthlyPriceUSD : null;
}

export interface PlanRow {
  planId: string; name: string; status: string; isFree: boolean; isPublic: boolean; isCustomPricing: boolean;
  monthlyPriceUSD: number | null; yearlyPriceUSD: number | null;
  /** How much cheaper a year is than 12 monthly payments, %. */
  yearlyDiscountPercent: number | null;
  transactionFeePercent: number | null; maxProducts: number | null;
  /** Stores on the plan now with an active / past-due subscription (free-plan stores included). */
  stores: number;
  payingStores: number; yearlyStores: number; pastDueStores: number;
  mrr: number; mrrSharePercent: number | null; arpu: number | null;
  /** Paying less than today's list price for their interval (an older price, an intro offer or a custom deal). */
  belowListStores: number; belowListGapMrr: number;
  /** Set to cancel at the end of the period. */
  cancelingStores: number; cancelingMrr: number;
  /** A cheaper plan is booked for their next renewal. */
  scheduledDowngrades: number; scheduledDowngradeMrr: number;
  // In the period:
  newStores: number; upgradesIn: number; downgradesIn: number; upgradesOut: number; downgradesOut: number;
  payingAtStart: number;
  /** Of the stores paying on this plan at the start, how many pay nothing now. */
  stoppedPaying: number; stoppedPayingPercent: number | null;
}

export interface MatrixRow { fromPlanId: string | null; fromName: string; toPlanId: string | null; toName: string; kind: MoveKind; moves: number; mrrChange: number }
export interface MonthRow { month: string; new: number; upgrades: number; downgrades: number; newMrr: number; upgradeMrr: number; downgradeMrr: number }
export interface Candidate { storeId: string; planId: string; planName: string; products: number; maxProducts: number; usagePercent: number; suggestedPlanId: string | null; suggestedPlanName: string | null; mrrIfUpgraded: number | null; currentMrr: number }

export interface InsightsInput {
  subs: InsightSub[];
  plans: PlanRecord[];
  from: number;
  now: number;
  months: string[];
  /** Live products per store (only stores on a plan with a product limit need to be present). */
  productCounts: Map<string, number>;
  /** Share of the product limit at which a store counts as outgrowing its plan. */
  limitThreshold?: number;
}

export function buildPlanInsights({ subs, plans, from, now, months, productCounts, limitThreshold = 0.8 }: InsightsInput) {
  const planMap = new Map<string, PlanRecord>(plans.map((p) => [String(p._id), p]));
  const nameOf = (id: string | null) => (id ? planMap.get(String(id))?.name ?? 'Unknown plan' : 'Trial / no plan');
  const rows = new Map<string, PlanRow>();
  const row = (planId: string | null): PlanRow => {
    const id = planId ? String(planId) : 'none';
    let r = rows.get(id);
    if (!r) {
      const p = planMap.get(id);
      const m = p?.monthlyPriceUSD ?? null, y = p?.yearlyPriceUSD ?? null;
      r = {
        planId: id, name: nameOf(planId), status: p?.status ?? 'active', isFree: !!p?.isFree, isPublic: p?.isPubliclyVisible !== false,
        isCustomPricing: !!p?.isCustomPricing, monthlyPriceUSD: m, yearlyPriceUSD: y,
        yearlyDiscountPercent: m && y ? round2((1 - y / (m * 12)) * 100) : null,
        transactionFeePercent: typeof p?.limits?.transactionFeeRate === 'number' ? round2(p.limits.transactionFeeRate * 100) : null,
        maxProducts: typeof p?.limits?.maxProducts === 'number' ? p.limits.maxProducts : null,
        stores: 0, payingStores: 0, yearlyStores: 0, pastDueStores: 0, mrr: 0, mrrSharePercent: null, arpu: null,
        belowListStores: 0, belowListGapMrr: 0, cancelingStores: 0, cancelingMrr: 0, scheduledDowngrades: 0, scheduledDowngradeMrr: 0,
        newStores: 0, upgradesIn: 0, downgradesIn: 0, upgradesOut: 0, downgradesOut: 0, payingAtStart: 0, stoppedPaying: 0, stoppedPayingPercent: null,
      };
      rows.set(id, r);
    }
    return r;
  };
  // Every active plan gets a row, even with no stores yet.
  for (const p of plans) if (p.status !== 'archived') row(String(p._id));

  // ── Now ────────────────────────────────────────────────────────────────
  let trialingStores = 0;
  const liveMrr = new Map<string, number>();
  for (const s of subs) {
    if (s.status === 'trialing') { trialingStores++; continue; }
    if (!['active', 'past_due'].includes(s.status) || !s.platformPlanId) continue;
    const r = row(s.platformPlanId);
    const mrr = round2(liveStoreMrr(s));
    r.stores++;
    if (s.status === 'past_due') r.pastDueStores++;
    if (mrr <= 0) continue;
    liveMrr.set(String(s.storeId), mrr);
    r.payingStores++; r.mrr = round2(r.mrr + mrr);
    if (s.billingInterval === 'yearly') r.yearlyStores++;
    const list = listMonthly(planMap.get(String(s.platformPlanId)), s.billingInterval);
    if (list !== null && mrr < list - 0.005) { r.belowListStores++; r.belowListGapMrr = round2(r.belowListGapMrr + list - mrr); }
    if (s.cancelAtPeriodEnd) { r.cancelingStores++; r.cancelingMrr = round2(r.cancelingMrr + mrr); }
    const sc = s.scheduledPlanChange;
    if (sc && !s.cancelAtPeriodEnd) {
      const next = toMonthly(sc.amountUSD ?? 0, sc.interval ?? s.billingInterval);
      if (next < mrr) { r.scheduledDowngrades++; r.scheduledDowngradeMrr = round2(r.scheduledDowngradeMrr + mrr - next); }
    }
  }

  // ── Moves in the period ────────────────────────────────────────────────
  const matrix = new Map<string, MatrixRow>();
  const monthly = new Map<string, MonthRow>(months.map((m) => [m, { month: m, new: 0, upgrades: 0, downgrades: 0, newMrr: 0, upgradeMrr: 0, downgradeMrr: 0 }]));
  let upgrades = 0, downgrades = 0, newStores = 0, intervalSwitches = 0, toYearly = 0, upgradeMrr = 0, downgradeMrr = 0, newMrr = 0;
  for (const s of subs) {
    for (const mv of planMoves(s, planMap)) {
      if (mv.at < from || mv.at > now) continue;
      const delta = round2(mv.toMrr - mv.fromMrr);
      const mo = monthly.get(monthKey(mv.at));
      if (mv.kind === 'new') { newStores++; newMrr += mv.toMrr; row(mv.toPlanId).newStores++; if (mo) { mo.new++; mo.newMrr = round2(mo.newMrr + mv.toMrr); } }
      if (mv.kind === 'upgrade') { upgrades++; upgradeMrr += delta; row(mv.toPlanId).upgradesIn++; row(mv.fromPlanId).upgradesOut++; if (mo) { mo.upgrades++; mo.upgradeMrr = round2(mo.upgradeMrr + delta); } }
      if (mv.kind === 'downgrade') { downgrades++; downgradeMrr -= delta; row(mv.toPlanId).downgradesIn++; row(mv.fromPlanId).downgradesOut++; if (mo) { mo.downgrades++; mo.downgradeMrr = round2(mo.downgradeMrr - delta); } }
      // Yearly works out cheaper per month, so a same-plan move that lowers the monthly price is monthly → yearly.
      if (mv.kind === 'interval') { intervalSwitches++; if (mv.toMrr < mv.fromMrr) toYearly++; }
      if (mv.kind === 'new' || mv.kind === 'interval') continue; // the matrix is for moves between plans
      const key = `${mv.fromPlanId}>${mv.toPlanId}`;
      const m = matrix.get(key) ?? { fromPlanId: mv.fromPlanId, fromName: nameOf(mv.fromPlanId), toPlanId: mv.toPlanId, toName: nameOf(mv.toPlanId), kind: mv.kind, moves: 0, mrrChange: 0 };
      m.moves++; m.mrrChange = round2(m.mrrChange + delta);
      matrix.set(key, m);
    }
  }

  // ── Who stopped paying, by the plan they were on at the start ──────────
  const startMap = reconstructMrrMapAt(subs, from, planMap);
  for (const [storeId, v] of startMap) {
    const r = row(v.planId);
    r.payingAtStart++;
    if (!liveMrr.has(storeId)) r.stoppedPaying++;
  }

  // ── Stores outgrowing their plan's product limit ──────────────────────
  const ladder = plans.filter((p) => p.status !== 'archived' && p.isPubliclyVisible !== false && !p.isFree && !p.isCustomPricing && (p.monthlyPriceUSD ?? 0) > 0)
    .sort((a, b) => (a.monthlyPriceUSD ?? 0) - (b.monthlyPriceUSD ?? 0));
  const candidates: Candidate[] = [];
  for (const s of subs) {
    if (!['active', 'past_due'].includes(s.status) || !s.platformPlanId) continue;
    const p = planMap.get(String(s.platformPlanId));
    const max = p?.limits?.maxProducts;
    if (typeof max !== 'number' || max <= 0) continue; // -1 = unlimited
    const products = productCounts.get(String(s.storeId)) ?? 0;
    if (products < max * limitThreshold) continue;
    const current = liveMrr.get(String(s.storeId)) ?? 0;
    const price = p?.isFree ? 0 : (p?.monthlyPriceUSD ?? 0);
    const next = ladder.find((x) => (x.monthlyPriceUSD ?? 0) > price && (x.limits?.maxProducts === -1 || (x.limits?.maxProducts ?? 0) > products));
    candidates.push({
      storeId: String(s.storeId), planId: String(s.platformPlanId), planName: nameOf(s.platformPlanId), products, maxProducts: max,
      usagePercent: round2((products / max) * 100), suggestedPlanId: next ? String(next._id) : null, suggestedPlanName: next?.name ?? null,
      mrrIfUpgraded: next ? round2(listMonthly(next, s.billingInterval) ?? next.monthlyPriceUSD ?? 0) : null, currentMrr: current,
    });
  }
  candidates.sort((a, b) => b.usagePercent - a.usagePercent || b.products - a.products);

  // ── Totals ─────────────────────────────────────────────────────────────
  const all = [...rows.values()];
  const totalMrr = round2(all.reduce((s, r) => s + r.mrr, 0));
  const paying = all.reduce((s, r) => s + r.payingStores, 0);
  for (const r of all) {
    r.mrrSharePercent = pct(r.mrr, totalMrr);
    r.arpu = r.payingStores > 0 ? round2(r.mrr / r.payingStores) : null;
    r.stoppedPayingPercent = pct(r.stoppedPaying, r.payingAtStart);
  }
  const sumOf = (f: (r: PlanRow) => number) => round2(all.reduce((s, r) => s + f(r), 0));
  const upgradeCandidates = candidates.filter((c) => c.suggestedPlanId);

  return {
    summary: {
      mrr: totalMrr, payingStores: paying, trialingStores,
      freePlanStores: all.filter((r) => r.isFree).reduce((s, r) => s + r.stores, 0),
      yearlySharePercent: pct(all.reduce((s, r) => s + r.yearlyStores, 0), paying),
      newStores, newMrr: round2(newMrr), upgrades, upgradeMrr: round2(upgradeMrr), downgrades, downgradeMrr: round2(downgradeMrr),
      /** Upgrades for every downgrade in the period. Null with no downgrades. */
      upgradeToDowngradeRatio: downgrades > 0 ? round2(upgrades / downgrades) : null,
      intervalSwitches, switchedToYearly: toYearly,
      belowListStores: sumOf((r) => r.belowListStores), belowListGapMrr: sumOf((r) => r.belowListGapMrr),
      cancelingStores: sumOf((r) => r.cancelingStores), cancelingMrr: sumOf((r) => r.cancelingMrr),
      scheduledDowngrades: sumOf((r) => r.scheduledDowngrades), scheduledDowngradeMrr: sumOf((r) => r.scheduledDowngradeMrr),
      outgrowingStores: candidates.length,
      upgradeOpportunityMrr: round2(upgradeCandidates.reduce((s, c) => s + Math.max(0, (c.mrrIfUpgraded ?? 0) - c.currentMrr), 0)),
    },
    // Paid plans by price, then free / custom, then the "no plan" bucket last.
    plans: all.sort((a, b) => (a.planId === 'none' ? 1 : 0) - (b.planId === 'none' ? 1 : 0)
      || Number(a.isFree) - Number(b.isFree) || (a.monthlyPriceUSD ?? Infinity) - (b.monthlyPriceUSD ?? Infinity) || a.name.localeCompare(b.name)),
    moves: [...matrix.values()].sort((a, b) => b.moves - a.moves || Math.abs(b.mrrChange) - Math.abs(a.mrrChange)),
    monthly: [...monthly.values()],
    candidates,
  };
}

