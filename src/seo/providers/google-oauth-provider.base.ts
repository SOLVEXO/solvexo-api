/* eslint-disable prettier/prettier */
import { ConfigService } from '@nestjs/config';
import { SeoOAuthTokens } from './seo-search-provider.interface';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Shared Google OAuth2 token-exchange logic for GSC/GA4/Merchant Center —
 * all three use the identical Google OAuth endpoints, differing only in
 * requested `scope`. Factored out here so the three provider adapters don't
 * each re-implement the same `fetch` calls against Google's token endpoint.
 *
 * Deliberately built on native `fetch` rather than `google-auth-library`
 * (present in node_modules only as an undeclared transitive dependency of
 * `passport-google-oauth20`, not a real package.json dependency).
 */
export abstract class GoogleOAuthProviderBase {
  protected abstract readonly scope: string;

  constructor(protected readonly config: ConfigService) {}

  protected get clientId() { return this.config.get<string>('GOOGLE_OAUTH_CLIENT_ID'); }
  protected get clientSecret() { return this.config.get<string>('GOOGLE_OAUTH_CLIENT_SECRET'); }

  getAuthorizationUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.scope,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<SeoOAuthTokens> {
    const data = await this.callTokenEndpoint({
      code,
      client_id: this.clientId ?? '',
      client_secret: this.clientSecret ?? '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }, 'exchanging authorization code');
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
    const data = await this.callTokenEndpoint({
      refresh_token: refreshToken,
      client_id: this.clientId ?? '',
      client_secret: this.clientSecret ?? '',
      grant_type: 'refresh_token',
    }, 'refreshing access token');
    return { accessToken: data.access_token, expiresAt: new Date(Date.now() + data.expires_in * 1000) };
  }

  private async callTokenEndpoint(body: Record<string, string>, action: string): Promise<any> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    if (!res.ok) throw new Error(`Google OAuth error while ${action}: ${await res.text()}`);
    return res.json();
  }
}

export function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
