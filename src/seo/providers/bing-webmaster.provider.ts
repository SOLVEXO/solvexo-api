/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { ISeoSearchProvider, SeoOAuthTokens, SeoCoverageResult, SeoPerformanceRow } from './seo-search-provider.interface';

const API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';

/**
 * Bing Webmaster Tools adapter. Unlike the three Google providers, Bing
 * Webmaster's API is authenticated with a plain API key generated in the
 * Bing Webmaster Tools UI — there is no OAuth2 flow. To keep this class a
 * drop-in `ISeoSearchProvider` (so `SeoIntegrationsService` doesn't need a
 * special case), `getAuthorizationUrl` returns a link to Bing's API-key
 * management page instead of a real OAuth redirect, and
 * `exchangeCodeForTokens`'s `code` parameter is simply the pasted API key —
 * stored as both "access token" and "refresh token" for interface
 * uniformity, since a Bing API key doesn't expire the way an OAuth token
 * does (so `refreshAccessToken` is a no-op that returns the same key back).
 */
@Injectable()
export class BingWebmasterProvider implements ISeoSearchProvider {
  readonly provider = 'bing' as const;
  private readonly logger = new Logger(BingWebmasterProvider.name);

  getAuthorizationUrl(): string {
    return 'https://www.bing.com/webmasters/home/mysites';
  }

  async exchangeCodeForTokens(apiKey: string): Promise<SeoOAuthTokens> {
    return {
      accessToken: apiKey,
      refreshToken: apiKey,
      expiresAt: new Date('2099-12-31'), // API keys don't expire on a schedule we can observe
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
    return { accessToken: refreshToken, expiresAt: new Date('2099-12-31') };
  }

  async verifyOwnership(apiKey: string, siteUrl: string): Promise<boolean> {
    const res = await fetch(`${API_BASE}/GetUserSites?apikey=${encodeURIComponent(apiKey)}`);
    if (!res.ok) return false;
    const sites = await res.json();
    return Array.isArray(sites) && sites.some((s: any) => normalizeSiteUrl(s.Url) === normalizeSiteUrl(siteUrl));
  }

  async syncCoverage(apiKey: string, siteUrl: string): Promise<SeoCoverageResult> {
    const res = await fetch(`${API_BASE}/GetCrawlStats?siteUrl=${encodeURIComponent(siteUrl)}&apikey=${encodeURIComponent(apiKey)}`);
    if (!res.ok) {
      return { indexedCount: 0, excludedCount: 0, errors: [`GetCrawlStats error: ${await res.text()}`] };
    }
    const stats = await res.json();
    const latest = Array.isArray(stats) ? stats[0] : null;
    return {
      indexedCount: latest?.CrawledPages ?? 0,
      excludedCount: latest?.BlockedByRobotsTxt ?? 0,
      errors: latest?.CrawlErrors ? [`${latest.CrawlErrors} crawl errors reported by Bing`] : [],
    };
  }

  async syncPerformance(apiKey: string, siteUrl: string): Promise<SeoPerformanceRow[]> {
    const res = await fetch(`${API_BASE}/GetRankAndTrafficStats?siteUrl=${encodeURIComponent(siteUrl)}&apikey=${encodeURIComponent(apiKey)}`);
    if (!res.ok) {
      this.logger.warn(`Bing GetRankAndTrafficStats failed: ${await res.text()}`);
      return [];
    }
    const rows = await res.json();
    return (Array.isArray(rows) ? rows : []).map((row: any) => ({
      date: row.Date ? new Date(row.Date).toISOString().slice(0, 10) : '',
      clicks: row.Clicks,
      impressions: row.Impressions,
      avgPosition: row.AvgClickPosition,
    }));
  }
}

function normalizeSiteUrl(url: string): string {
  return url.replace(/\/$/, '').toLowerCase();
}
