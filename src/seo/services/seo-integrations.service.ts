/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { encryptSeoCredential, decryptSeoCredential } from '@/common/seo-token-encryption.util';
import { GoogleSearchConsoleProvider } from '../providers/google-search-console.provider';
import { GoogleAnalyticsProvider } from '../providers/google-analytics.provider';
import { GoogleMerchantCenterProvider } from '../providers/google-merchant-center.provider';
import { BingWebmasterProvider } from '../providers/bing-webmaster.provider';
import { ISeoSearchProvider, SeoCoverageResult, SeoPerformanceRow } from '../providers/seo-search-provider.interface';
import { SeoIntegrationProvider } from '../schemas/seo-integration.schema';

/** "123456789" or "properties/123456789" → "properties/123456789" (null when it isn't a GA4 property id). */
export function normalizeGa4Property(raw: unknown): string | null {
  const m = /^(?:properties\/)?(\d{4,20})$/.exec(String(raw ?? '').trim());
  return m ? `properties/${m[1]}` : null;
}

export interface SeoIntegrationScope {
  scope: 'platform' | 'store';
  storeId: string | null;
  sellerId?: string | null;
}

/**
 * Thin orchestrator over the 4 `ISeoSearchProvider` adapters — owns the
 * concerns every provider shares exactly once: token encryption at rest,
 * the `status` state machine, and activity logging. See architecture plan
 * Refinement #2 and #8.
 */
@Injectable()
export class SeoIntegrationsService {
  private readonly providers: Record<SeoIntegrationProvider, ISeoSearchProvider>;

  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
    gsc: GoogleSearchConsoleProvider,
    ga4: GoogleAnalyticsProvider,
    merchantCenter: GoogleMerchantCenterProvider,
    bing: BingWebmasterProvider,
  ) {
    this.providers = { gsc, ga4, merchant_center: merchantCenter, bing };
  }

  private get model() {
    return this.db.repositories.seoIntegrationModel;
  }

  private getProvider(provider: SeoIntegrationProvider): ISeoSearchProvider {
    const impl = this.providers[provider];
    if (!impl) throw new BadRequestException(`Unknown SEO integration provider "${provider}".`);
    return impl;
  }

  getAuthorizationUrl(provider: SeoIntegrationProvider, redirectUri: string, state: string): string {
    return this.getProvider(provider).getAuthorizationUrl(redirectUri, state);
  }

  async list(scope: SeoIntegrationScope) {
    return this.model.find({ scope: scope.scope, storeId: scope.storeId }).select('-accessTokenEncrypted -refreshTokenEncrypted').lean();
  }

  async connect(
    scope: SeoIntegrationScope,
    provider: SeoIntegrationProvider,
    authCode: string,
    redirectUri: string,
    siteIdentifier: string,
    actor: { id: string; name?: string; role?: string },
  ) {
    const impl = this.getProvider(provider);
    const tokens = await impl.exchangeCodeForTokens(authCode, redirectUri);

    const owns = await impl.verifyOwnership(tokens.accessToken, siteIdentifier);
    if (!owns) {
      throw new BadRequestException(`This account does not have verified access to "${siteIdentifier}" on ${provider}.`);
    }

    const integration = await this.model.findOneAndUpdate(
      { scope: scope.scope, storeId: scope.storeId, provider },
      {
        $set: {
          scope: scope.scope,
          storeId: scope.storeId,
          sellerId: scope.sellerId ?? null,
          provider,
          accessTokenEncrypted: encryptSeoCredential(tokens.accessToken),
          refreshTokenEncrypted: tokens.refreshToken ? encryptSeoCredential(tokens.refreshToken) : null,
          accessTokenExpiresAt: tokens.expiresAt,
          config: { siteIdentifier },
          status: 'connected',
          lastError: null,
        },
      },
      { upsert: true, new: true },
    );

    await this.activityLog.log({
      storeId: scope.storeId ?? undefined,
      category: 'seo',
      action: 'seo_integration_connected',
      description: `${provider} connected for ${siteIdentifier}`,
      actorId: actor.id, actorName: actor.name ?? null, actorRole: actor.role ?? null,
      targetId: integration._id.toString(), targetType: 'seo_integration',
    });

    return { success: true, status: integration.status };
  }

  async disconnect(scope: SeoIntegrationScope, provider: SeoIntegrationProvider, actor: { id: string; name?: string; role?: string }) {
    const integration = await this.model.findOne({ scope: scope.scope, storeId: scope.storeId, provider });
    if (!integration) throw new NotFoundException('Integration not found.');

    integration.status = 'disconnected';
    integration.accessTokenEncrypted = null;
    integration.refreshTokenEncrypted = null;
    await integration.save();

    await this.activityLog.log({
      storeId: scope.storeId ?? undefined,
      category: 'seo',
      action: 'seo_integration_disconnected',
      actorId: actor.id, actorName: actor.name ?? null, actorRole: actor.role ?? null,
      targetId: integration._id.toString(), targetType: 'seo_integration',
    });

    return { success: true };
  }

  /**
   * Pulls a fresh access token (refreshing if needed), calls the provider's
   * coverage+performance methods, and updates the integration's own
   * status/lastSyncedAt. Does NOT persist the results into
   * SeoIndexSnapshot/SeoAnalyticsSnapshot — that's `SeoMonitoringService`'s
   * job (Phase 5), which calls this and stores the returned data.
   */
  async sync(
    scope: SeoIntegrationScope,
    provider: SeoIntegrationProvider,
    from: Date,
    to: Date,
  ): Promise<{ coverage: SeoCoverageResult; performance: SeoPerformanceRow[] }> {
    const integration = await this.model.findOne({ scope: scope.scope, storeId: scope.storeId, provider });
    if (!integration || integration.status === 'disconnected') throw new NotFoundException('Integration not connected.');

    const impl = this.getProvider(provider);
    const siteIdentifier = integration.config?.siteIdentifier;

    try {
      integration.status = 'syncing';
      await integration.save();

      const accessToken = await this.getValidAccessToken(integration, impl);
      const [coverage, performance] = await Promise.all([
        impl.syncCoverage(accessToken, siteIdentifier),
        impl.syncPerformance(accessToken, siteIdentifier, from, to),
      ]);

      integration.status = 'connected';
      integration.lastSyncedAt = new Date();
      integration.lastError = null;
      await integration.save();

      return { coverage, performance };
    } catch (err: any) {
      const isAuthError = /invalid_grant|unauthorized|401|403/i.test(err?.message ?? '');
      integration.status = isAuthError ? 'needs_reauth' : 'error';
      integration.lastError = err?.message ?? 'Unknown sync error';
      await integration.save();
      throw err;
    }
  }

  /** Solvexo's own GA4 connection (Super Admin → SEO → Integrations), for the visitor dashboard. */
  async platformGa4Status(): Promise<{ connected: boolean; status: string | null; propertyId: string | null; lastError: string | null }> {
    const row: any = await this.model.findOne({ scope: 'platform', storeId: null, provider: 'ga4' }).select('status config lastError').lean();
    const propertyId = normalizeGa4Property(row?.config?.siteIdentifier);
    const connected = !!row && row.status !== 'disconnected' && !!propertyId;
    return { connected, status: row?.status ?? null, propertyId, lastError: row?.lastError ?? null };
  }

  /** A fresh access token for the platform GA4 property, or null when it isn't connected. */
  async platformGa4Access(): Promise<{ accessToken: string; propertyId: string } | null> {
    const integration = await this.model.findOne({ scope: 'platform', storeId: null, provider: 'ga4' });
    const propertyId = normalizeGa4Property(integration?.config?.siteIdentifier);
    if (!integration || integration.status === 'disconnected' || !propertyId) return null;
    try {
      return { accessToken: await this.getValidAccessToken(integration, this.getProvider('ga4')), propertyId };
    } catch (err: any) {
      await this.markPlatformGa4NeedsReauth(err?.message ?? 'Token refresh failed');
      throw err;
    }
  }

  /** Google refused the platform GA4 token (revoked or expired): the admin must reconnect. */
  async markPlatformGa4NeedsReauth(message: string): Promise<void> {
    await this.model.updateOne({ scope: 'platform', storeId: null, provider: 'ga4' }, { $set: { status: 'needs_reauth', lastError: message } });
  }

  private async getValidAccessToken(integration: any, impl: ISeoSearchProvider): Promise<string> {
    const isExpired = !integration.accessTokenExpiresAt || integration.accessTokenExpiresAt.getTime() <= Date.now() + 60_000;
    if (!isExpired && integration.accessTokenEncrypted) {
      return decryptSeoCredential(integration.accessTokenEncrypted);
    }
    if (!integration.refreshTokenEncrypted) {
      throw new Error('No refresh token on file — reconnection required (needs_reauth).');
    }
    const refreshToken = decryptSeoCredential(integration.refreshTokenEncrypted);
    const refreshed = await impl.refreshAccessToken(refreshToken);
    integration.accessTokenEncrypted = encryptSeoCredential(refreshed.accessToken);
    integration.accessTokenExpiresAt = refreshed.expiresAt;
    await integration.save();
    return refreshed.accessToken;
  }
}
