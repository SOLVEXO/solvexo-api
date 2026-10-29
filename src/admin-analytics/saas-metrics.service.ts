/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { PlatformMrrSnapshot, PlatformMrrSnapshotDocument } from './schemas/platform-mrr-snapshot.schema';
import {
  type PlanInfo, type StoreMrrMap, type SubRow, cohorts, firstPaidAt, lifetimeValue, liveMrrMap,
  monthKey, monthPoints, movementBetween, reconstructMrrMapAt, round2, totalMrr, trialFunnel,
} from './saas-metrics.util';

const SUB_FIELDS = 'storeId status platformPlanId amountUSD billingInterval startedAt trialEndsAt canceledAt lockedAt gracePeriodEndsAt updatedAt planHistory';
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Admin SaaS metrics for Solvexo's own subscription revenue (stores paying for platform plans): MRR movement, NRR,
 * churn, ARPU, LTV, cohort retention and the trial funnel. The maths lives in saas-metrics.util.ts.
 *
 * History: each month-end uses the daily snapshot of that day when one exists (exact), otherwise it is rebuilt from
 * the subscription records (close, but can't see a lapse that was later reactivated). "Now" is always live, so the
 * current MRR matches the Overview and Billing pages.
 */
@Injectable()
export class SaasMetricsService {
  private readonly logger = new Logger(SaasMetricsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    @InjectModel(PlatformMrrSnapshot.name) private readonly snapshots: Model<PlatformMrrSnapshotDocument>,
  ) {}

  private async load() {
    const [subs, plans] = await Promise.all([
      this.db.repositories.sellerPlatformSubscriptionModel.find({ isDelete: { $ne: true } }).select(SUB_FIELDS).lean() as Promise<any[]>,
      this.db.repositories.platformPlanModel.find({}).select('name isFree monthlyPriceUSD yearlyPriceUSD gracePeriodDays').lean() as Promise<any[]>,
    ]);
    const planMap = new Map<string, PlanInfo & { name?: string }>(plans.map((p) => [String(p._id), p]));
    return { subs: subs as SubRow[], plans: planMap };
  }

  /** 23:55 UTC daily: today's end-of-day MRR per paying store. Idempotent (one row per day, upserted). */
  @Cron('55 23 * * *')
  async captureDailySnapshot() {
    await this.redis.withLock('cron-lock:platform-mrr-snapshot', 10 * 60_000, async () => {
      const { date, payingStores, totalMrr: mrr } = await this.captureSnapshot();
      this.logger.log(`MRR snapshot ${date}: $${mrr} from ${payingStores} paying stores`);
    });
  }

  async captureSnapshot(now = Date.now()) {
    const { subs } = await this.load();
    const map = liveMrrMap(subs);
    const doc = {
      date: dayKey(now),
      stores: [...map].map(([storeId, v]) => ({ storeId, planId: v.planId, mrr: v.mrr })),
      totalMrr: totalMrr(map), payingStores: map.size,
    };
    await this.snapshots.updateOne({ date: doc.date }, { $set: doc }, { upsert: true });
    return doc;
  }

  async getMetrics(monthsWanted = 12, now = Date.now()) {
    const months = Math.min(Math.max(Math.trunc(monthsWanted) || 12, 3), 24);
    const { subs, plans } = await this.load();

    // One extra point before the window, so the first month shown has a movement too.
    const points = monthPoints(months + 1, now);
    const snapshotDocs: any[] = await this.snapshots.find({ date: { $in: points.map(dayKey) } }).lean();
    const byDay = new Map(snapshotDocs.map((d) => [d.date, d]));
    const firstSnapshot: any = await this.snapshots.findOne({}).sort({ date: 1 }).select('date').lean();

    const series = points.map((at, i) => {
      const isNow = i === points.length - 1;
      const snap = isNow ? null : byDay.get(dayKey(at));
      const map: StoreMrrMap = isNow ? liveMrrMap(subs)
        : snap ? new Map(snap.stores.map((s: any) => [String(s.storeId), { mrr: s.mrr, planId: s.planId ?? null }]))
        : reconstructMrrMapAt(subs, at, plans);
      return { month: monthKey(at), at, map, source: isNow ? 'live' : snap ? 'snapshot' : 'reconstructed' };
    });

    const firstPaid = new Map<string, number>();
    for (const s of subs) {
      const at = firstPaidAt(s, plans);
      if (at !== null) firstPaid.set(String(s.storeId), at);
    }
    // "Paid before" = seen paying at an earlier point, or first paid before the window began.
    const seen = new Set<string>([...firstPaid].filter(([, at]) => at <= series[0].at).map(([id]) => id));
    for (const id of series[0].map.keys()) seen.add(id);

    const monthly = series.slice(1).map((p, i) => {
      const prev = series[i];
      const m = movementBetween(prev.map, p.map, (id) => seen.has(id));
      for (const id of p.map.keys()) seen.add(id);
      return {
        month: p.month, source: p.source,
        mrr: m.endMrr, arr: round2(m.endMrr * 12), payingStores: m.endStores,
        arpu: m.endStores > 0 ? round2(m.endMrr / m.endStores) : 0,
        ...m,
      };
    });

    const current = monthly[monthly.length - 1];
    const last = (n: number) => monthly.slice(-n);
    const ltv = lifetimeValue(current.arpu, last(6));
    // Trailing-12-month NRR: the stores paying a year ago, their MRR now vs then.
    const yearAgo = series.length > 12 ? series[series.length - 13] : series[0];
    const nrr12 = movementBetween(yearAgo.map, series[series.length - 1].map, () => true).nrrPercent;

    const planNames = new Map([...plans].map(([id, p]) => [id, p.name ?? 'Unknown plan']));
    const byPlan = new Map<string, { planId: string; planName: string; stores: number; mrr: number }>();
    for (const [, v] of series[series.length - 1].map) {
      const key = v.planId ?? 'none';
      const row = byPlan.get(key) ?? { planId: key, planName: planNames.get(key) ?? 'Unknown plan', stores: 0, mrr: 0 };
      row.stores++; row.mrr = round2(row.mrr + v.mrr);
      byPlan.set(key, row);
    }

    const totals = (key: 'newMrr' | 'expansionMrr' | 'contractionMrr' | 'churnedMrr' | 'reactivationMrr') => round2(monthly.reduce((s, m) => s + m[key], 0));
    return {
      success: true,
      data: {
        asOf: new Date(now).toISOString(),
        months,
        current: {
          mrr: current.mrr, arr: current.arr, payingStores: current.payingStores, arpu: current.arpu,
          netNewMrrThisMonth: current.netNewMrr,
          nrrPercentTrailing12: nrr12,
          nrrPercentThisMonth: current.nrrPercent,
          grrPercentThisMonth: current.grrPercent,
          logoChurnPercentThisMonth: current.logoChurnPercent,
          revenueChurnPercentThisMonth: current.revenueChurnPercent,
          quickRatioThisMonth: current.quickRatio,
          ...ltv,
        },
        periodTotals: {
          newMrr: totals('newMrr'), expansionMrr: totals('expansionMrr'), reactivationMrr: totals('reactivationMrr'),
          contractionMrr: totals('contractionMrr'), churnedMrr: totals('churnedMrr'),
        },
        monthly,
        byPlan: [...byPlan.values()].sort((a, b) => b.mrr - a.mrr),
        cohorts: cohorts(new Map([...firstPaid].filter(([, at]) => at > series[0].at)), series.slice(1).map((p) => ({ month: p.month, map: p.map }))),
        trials: trialFunnel(subs, plans, series.slice(1).map((p) => p.month)),
        dataQuality: {
          firstDailySnapshot: firstSnapshot?.date ?? null,
          reconstructedMonths: monthly.filter((m) => m.source === 'reconstructed').map((m) => m.month),
        },
      },
    };
  }

  /** CSV of the monthly table, for spreadsheets. */
  async exportCsv(monthsWanted = 12): Promise<string> {
    const { data } = await this.getMetrics(monthsWanted);
    const cols = ['month', 'source', 'mrr', 'arr', 'payingStores', 'arpu', 'newMrr', 'expansionMrr', 'reactivationMrr', 'contractionMrr', 'churnedMrr', 'netNewMrr', 'newStores', 'churnedStores', 'reactivatedStores', 'nrrPercent', 'grrPercent', 'logoChurnPercent', 'revenueChurnPercent', 'quickRatio'] as const;
    const rows = data.monthly.map((m: any) => cols.map((c) => (m[c] ?? '')).join(','));
    return [cols.join(','), ...rows].join('\n');
  }
}

