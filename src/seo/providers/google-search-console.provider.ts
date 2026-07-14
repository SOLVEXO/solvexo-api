/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ISeoSearchProvider, SeoCoverageResult, SeoPerformanceRow } from './seo-search-provider.interface';
import { GoogleOAuthProviderBase, toDateString } from './google-oauth-provider.base';

const API_BASE = 'https://www.googleapis.com/webmasters/v3';

/**
 * Google Search Console adapter. `syncCoverage` approximates "index
 * coverage" via the Sitemaps API (submitted vs. indexed URL counts per
 * sitemap) — GSC's true per-URL Index Coverage report isn't exposed by a
 * bulk API, only the UI and the single-URL Inspection API, which isn't
 * practical to call per-URL at marketplace scale.
 */
@Injectable()
export class GoogleSearchConsoleProvider extends GoogleOAuthProviderBase implements ISeoSearchProvider {
  readonly provider = 'gsc' as const;
  protected readonly scope = 'https://www.googleapis.com/auth/webmasters.readonly';
  private readonly logger = new Logger(GoogleSearchConsoleProvider.name);

  constructor(config: ConfigService) {
    super(config);
  }

  async verifyOwnership(accessToken: string, siteUrl: string): Promise<boolean> {
    const res = await fetch(`${API_BASE}/sites/${encodeURIComponent(siteUrl)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.permissionLevel && data.permissionLevel !== 'siteUnverifiedUser';
  }

  async syncCoverage(accessToken: string, siteUrl: string): Promise<SeoCoverageResult> {
    const res = await fetch(`${API_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      return { indexedCount: 0, excludedCount: 0, errors: [`Sitemaps API error: ${await res.text()}`] };
    }
    const data = await res.json();
    const sitemaps = data.sitemap ?? [];
    let indexedCount = 0;
    let submittedCount = 0;
    const errors: string[] = [];
    for (const sitemap of sitemaps) {
      for (const entry of sitemap.contents ?? []) {
        submittedCount += Number(entry.submitted ?? 0);
        indexedCount += Number(entry.indexed ?? 0);
      }
      if (sitemap.errors > 0) errors.push(`${sitemap.path}: ${sitemap.errors} error(s)`);
    }
    return { indexedCount, excludedCount: Math.max(0, submittedCount - indexedCount), errors };
  }

  async syncPerformance(accessToken: string, siteUrl: string, from: Date, to: Date): Promise<SeoPerformanceRow[]> {
    const res = await fetch(`${API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate: toDateString(from), endDate: toDateString(to), dimensions: ['date'], rowLimit: 1000 }),
    });
    if (!res.ok) {
      this.logger.warn(`GSC searchAnalytics query failed: ${await res.text()}`);
      return [];
    }
    const data = await res.json();
    return (data.rows ?? []).map((row: any) => ({
      date: row.keys[0], clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, avgPosition: row.position,
    }));
  }
}
