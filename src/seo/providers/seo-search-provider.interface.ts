/* eslint-disable prettier/prettier */
import { SeoIntegrationProvider } from '../schemas/seo-integration.schema';

export interface SeoOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
}

export interface SeoCoverageResult {
  indexedCount: number;
  excludedCount: number;
  errors: string[];
}

export interface SeoPerformanceRow {
  date: string; // YYYY-MM-DD
  clicks?: number;
  impressions?: number;
  ctr?: number;
  avgPosition?: number;
  organicSessions?: number;
}

/**
 * Strategy interface for a single search/analytics provider — mirrors
 * `subscriptions/payment-gateway/payment-gateway.interface.ts`'s
 * `IPaymentGateway` (see architecture plan Refinement #2). One adapter class
 * per provider; `SeoIntegrationsService` is a thin orchestrator that selects
 * the right adapter and owns the shared concerns (token encryption, status
 * state machine, activity logging) exactly once instead of a 4-way
 * if/else branch.
 *
 * Not every provider has a meaningful concept of "index coverage" (GA4
 * doesn't) or "click/impression performance" (Merchant Center's own traffic
 * data requires a separate Reports API, out of scope for this MVP) — those
 * methods return empty/zeroed results with a code comment in that case,
 * rather than each caller having to know which providers support what.
 */
export interface ISeoSearchProvider {
  readonly provider: SeoIntegrationProvider;

  /** Bing has no OAuth flow (API-key based) — see BingWebmasterProvider for how it adapts this same interface shape. */
  getAuthorizationUrl(redirectUri: string, state: string): string;

  exchangeCodeForTokens(code: string, redirectUri: string): Promise<SeoOAuthTokens>;

  refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date }>;

  /** Confirms the connected account actually owns/manages the given site/property identifier before we trust it. */
  verifyOwnership(accessToken: string, siteIdentifier: string): Promise<boolean>;

  syncCoverage(accessToken: string, siteIdentifier: string): Promise<SeoCoverageResult>;

  syncPerformance(accessToken: string, siteIdentifier: string, from: Date, to: Date): Promise<SeoPerformanceRow[]>;
}
