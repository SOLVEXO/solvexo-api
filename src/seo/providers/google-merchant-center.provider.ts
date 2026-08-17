/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ISeoSearchProvider, SeoCoverageResult, SeoPerformanceRow } from './seo-search-provider.interface';
import { GoogleOAuthProviderBase } from './google-oauth-provider.base';

const API_BASE = 'https://shoppingcontent.googleapis.com/content/v2.1';

/**
 * Google Merchant Center (Content API for Shopping) adapter.
 * `siteIdentifier` is the Merchant Center account id. `syncCoverage` maps
 * onto product-feed health: "indexed" = approved products, "excluded" =
 * disapproved/pending. `syncPerformance` (clicks/impressions on Shopping
 * ads) requires the separate Merchant Center Reports API, which is a
 * distinct integration surface — out of scope for this MVP, so this
 * deliberately returns an empty array rather than a half-built reports
 * integration; product-listing SEO click/impression data instead comes
 * from GSC/GA4.
 */
@Injectable()
export class GoogleMerchantCenterProvider extends GoogleOAuthProviderBase implements ISeoSearchProvider {
  readonly provider = 'merchant_center' as const;
  protected readonly scope = 'https://www.googleapis.com/auth/content';
  private readonly logger = new Logger(GoogleMerchantCenterProvider.name);

  constructor(config: ConfigService) {
    super(config);
  }

  async verifyOwnership(accessToken: string, merchantId: string): Promise<boolean> {
    const res = await fetch(`${API_BASE}/${merchantId}/accounts/${merchantId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok;
  }

  async syncCoverage(accessToken: string, merchantId: string): Promise<SeoCoverageResult> {
    const res = await fetch(`${API_BASE}/${merchantId}/productstatuses?maxResults=250`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      return { indexedCount: 0, excludedCount: 0, errors: [`productstatuses API error: ${await res.text()}`] };
    }
    const data = await res.json();
    const resources = data.resources ?? [];
    let indexedCount = 0;
    let excludedCount = 0;
    const errors: string[] = [];
    for (const resource of resources) {
      const destinationStatuses = resource.destinationStatuses ?? [];
      const isApprovedAnywhere = destinationStatuses.some((d: any) => (d.approvedCountries ?? []).length > 0);
      if (isApprovedAnywhere) indexedCount++; else excludedCount++;
      for (const issue of resource.itemLevelIssues ?? []) {
        if (issue.severity === 'error') errors.push(`${resource.productId}: ${issue.description}`);
      }
    }
    return { indexedCount, excludedCount, errors: errors.slice(0, 50) };
  }

  async syncPerformance(): Promise<SeoPerformanceRow[]> {
    this.logger.debug('Merchant Center click/impression data requires the separate Reports API — not implemented in this MVP.');
    return [];
  }
}
