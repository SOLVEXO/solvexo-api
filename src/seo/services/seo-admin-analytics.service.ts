/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';

/**
 * Reads `SeoAnalyticsSnapshot` (populated by `SeoIntegrationsService.sync` +
 * the nightly cron) for both the admin platform-wide dashboard and the
 * seller store-scoped dashboard (Phase 9) — same "one scoped read layer
 * shared by admin and seller" shape as `analytics`/`admin-analytics`.
 */
@Injectable()
export class SeoAdminAnalyticsService {
  constructor(private readonly db: DatabaseService) {}

  async getOverview(scope: 'platform' | 'store', storeId: string | null, days = 28) {
    const since = dateNDaysAgo(days);
    const rows = await this.db.repositories.seoAnalyticsSnapshotModel
      .find({ scope, storeId, date: { $gte: since } })
      .lean();

    const totals = rows.reduce(
      (acc, r: any) => {
        acc.clicks += r.clicks ?? 0;
        acc.impressions += r.impressions ?? 0;
        acc.organicSessions += r.organicSessions ?? 0;
        return acc;
      },
      { clicks: 0, impressions: 0, organicSessions: 0 },
    );
    const avgPosition = average(rows.map((r: any) => r.avgPosition).filter((v: any) => v != null));
    const avgCtr = totals.impressions > 0 ? totals.clicks / totals.impressions : null;

    return { ...totals, avgPosition, avgCtr, days };
  }

  async getSearchPerformance(scope: 'platform' | 'store', storeId: string | null, days = 28) {
    const since = dateNDaysAgo(days);
    return this.db.repositories.seoAnalyticsSnapshotModel
      .find({ scope, storeId, provider: { $in: ['gsc', 'bing'] }, date: { $gte: since } })
      .sort({ date: 1 })
      .lean();
  }

  async getOrganicTraffic(scope: 'platform' | 'store', storeId: string | null, days = 28) {
    const since = dateNDaysAgo(days);
    return this.db.repositories.seoAnalyticsSnapshotModel
      .find({ scope, storeId, provider: 'ga4', date: { $gte: since } })
      .sort({ date: 1 })
      .lean();
  }
}

function dateNDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
