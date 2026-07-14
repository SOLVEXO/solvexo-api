/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ISeoSearchProvider, SeoCoverageResult, SeoPerformanceRow } from './seo-search-provider.interface';
import { GoogleOAuthProviderBase, toDateString } from './google-oauth-provider.base';

const DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const ADMIN_API_BASE = 'https://analyticsadmin.googleapis.com/v1beta';

/**
 * GA4 (Analytics Data API) adapter. `siteIdentifier` is the GA4 property id
 * (e.g. "properties/123456789"). `syncCoverage` has no meaning for GA4 (it
 * has no concept of search-index coverage) — returns zeros rather than
 * faking data, documented here rather than surprising a caller.
 */
@Injectable()
export class GoogleAnalyticsProvider extends GoogleOAuthProviderBase implements ISeoSearchProvider {
  readonly provider = 'ga4' as const;
  protected readonly scope = 'https://www.googleapis.com/auth/analytics.readonly';
  private readonly logger = new Logger(GoogleAnalyticsProvider.name);

  constructor(config: ConfigService) {
    super(config);
  }

  async verifyOwnership(accessToken: string, propertyId: string): Promise<boolean> {
    const res = await fetch(`${ADMIN_API_BASE}/${propertyId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok;
  }

  // GA4 has no "index coverage" concept — intentionally a no-op returning zeros.
  async syncCoverage(): Promise<SeoCoverageResult> {
    return { indexedCount: 0, excludedCount: 0, errors: [] };
  }

  async syncPerformance(accessToken: string, propertyId: string, from: Date, to: Date): Promise<SeoPerformanceRow[]> {
    const res = await fetch(`${DATA_API_BASE}/${propertyId}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: toDateString(from), endDate: toDateString(to) }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'sessions' }],
        dimensionFilter: {
          filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { value: 'Organic Search' } },
        },
      }),
    });
    if (!res.ok) {
      this.logger.warn(`GA4 runReport failed: ${await res.text()}`);
      return [];
    }
    const data = await res.json();
    return (data.rows ?? []).map((row: any) => ({
      date: formatGa4Date(row.dimensionValues?.[0]?.value),
      organicSessions: Number(row.metricValues?.[0]?.value ?? 0),
    }));
  }
}

/** GA4 returns dates as "YYYYMMDD" — normalize to "YYYY-MM-DD" to match SeoAnalyticsSnapshot's convention. */
function formatGa4Date(raw: string | undefined): string {
  if (!raw || raw.length !== 8) return raw ?? '';
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}
