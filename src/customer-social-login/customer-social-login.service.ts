/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { AuthService } from '../auth/auth.service';
import { GuestSessionService } from '../auth/guest-session.service';
import { API_PUBLIC_ORIGIN } from '../common/api-origin';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { encryptCredential, decryptCredential, maskSecret } from '../common/credential-encryption.util';
import { SocialLoginDto } from '../auth/dto/social-login.dto';

/**
 * Shopify-style "Customer accounts → Authentication → Google / Facebook": every store connects ITS OWN
 * Google/Facebook OAuth app (Client ID + secret pasted by the merchant) and its buyers sign in through it with
 * the standard OAuth "authorization code" redirect flow. Nothing here touches the platform's own Google login
 * (seller/admin sign-in on solvexo.store) — that stays in AuthService.socialLogin.
 *
 * Credentials live on a `StoreIntegration` row (type `customer_login`) as one AES-256-GCM blob and are never
 * returned by any response — only a last-4 hint.
 */
export type SocialProviderKey = 'google' | 'facebook';
export const SOCIAL_PROVIDER_KEYS: SocialProviderKey[] = ['google', 'facebook'];

const INTEGRATION_PROVIDER: Record<SocialProviderKey, 'google_login' | 'facebook_login'> = {
  google: 'google_login',
  facebook: 'facebook_login',
};

const STATE_TTL_MS = 10 * 60 * 1000;
const EXCHANGE_CODE_TTL_S = 60;
const FACEBOOK_API = 'v19.0';

type StatePayload = { storeId: string; provider: SocialProviderKey; returnTo: string; nonce: string; exp: number };

@Injectable()
export class CustomerSocialLoginService {
  private readonly logger = new Logger(CustomerSocialLoginService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redisService: RedisService,
    private readonly authService: AuthService,
    private readonly guestSessions: GuestSessionService,
  ) {}

  private get repos() {
    return this.databaseService.repositories;
  }

  /** Per-store like Shopify: each store registers its OWN redirect address in its own Google/Facebook app. */
  redirectUri(provider: SocialProviderKey, storeId: string): string {
    return `${API_PUBLIC_ORIGIN}/api/auth/social/callback/${provider}/${storeId}`;
  }

  // ───────────────────────── seller side (Settings → Customer accounts) ─────────────────────────

  async getSetup(storeId: string, sellerId: string) {
    const store = await verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
    const rows = await this.repos.storeIntegrationModel.find({ storeId, type: 'customer_login' });
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    const providers = SOCIAL_PROVIDER_KEYS.map((provider) => {
      const row = byProvider.get(INTEGRATION_PROVIDER[provider]);
      return {
        provider,
        status: row?.status === 'connected' ? 'connected' : 'not_connected',
        clientId: row?.config?.clientId ?? null,
        maskedSecret: row?.config?.maskedSecret ?? null,
        redirectUri: this.redirectUri(provider, storeId),
        connectedAt: row ? (row as any).updatedAt : null,
      };
    });
    return { success: true, data: { providers, storeOrigins: this.allowedOrigins(store) } };
  }

  async connect(storeId: string, sellerId: string, provider: SocialProviderKey, body: { clientId?: string; clientSecret?: string }) {
    await verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
    const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
    const clientSecret = typeof body?.clientSecret === 'string' ? body.clientSecret.trim() : '';
    if (!clientId || !clientSecret) {
      throw new BadRequestException(provider === 'facebook' ? 'App ID and App secret are required' : 'Client ID and Client secret are required');
    }
    if (clientId.length > 256 || clientSecret.length > 512) throw new BadRequestException('Credentials are too long');

    const integrationProvider = INTEGRATION_PROVIDER[provider];
    await this.repos.storeIntegrationModel.findOneAndUpdate(
      { storeId, type: 'customer_login', provider: integrationProvider },
      {
        $set: {
          sellerId,
          mode: 'live',
          status: 'connected',
          credentialsEncrypted: encryptCredential(JSON.stringify({ clientId, clientSecret }), 'INTEGRATIONS'),
          config: { clientId, maskedSecret: maskSecret(clientSecret) },
          lastError: null,
          lastVerifiedAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );
    return this.getSetup(storeId, sellerId);
  }

  async disconnect(storeId: string, sellerId: string, provider: SocialProviderKey) {
    await verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
    await this.repos.storeIntegrationModel.deleteOne({ storeId, type: 'customer_login', provider: INTEGRATION_PROVIDER[provider] });
    return this.getSetup(storeId, sellerId);
  }

  // ───────────────────────── buyer side ─────────────────────────

  /** Which provider buttons the storefront login/register pages may show. Names only — never credentials. */
  async connectedProviders(storeId: string): Promise<SocialProviderKey[]> {
    if (!storeId) return [];
    const rows = await this.repos.storeIntegrationModel.find({ storeId, type: 'customer_login', status: 'connected' }).select('provider');
    return SOCIAL_PROVIDER_KEYS.filter((p) => rows.some((r) => r.provider === INTEGRATION_PROVIDER[p]));
  }

  /** Builds the provider's consent-page URL (the "Choose an account" screen) for this store's own app. */
  async buildAuthUrl(storeId: string, provider: SocialProviderKey, returnTo: string): Promise<string> {
    const store = await this.repos.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new BadRequestException('Store not found');
    const origin = this.normalizeOrigin(returnTo);
    if (!origin || !this.allowedOrigins(store).includes(origin)) throw new BadRequestException('Invalid return address');
    const { clientId } = await this.loadCredentials(storeId, provider);

    const state = this.signState({ storeId, provider, returnTo: origin, nonce: randomBytes(8).toString('hex'), exp: Date.now() + STATE_TTL_MS });
    const redirect = this.redirectUri(provider, storeId);
    if (provider === 'google') {
      const q = new URLSearchParams({
        client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'openid email profile',
        state, prompt: 'select_account',
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
    }
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, state, scope: 'email,public_profile', response_type: 'code' });
    return `https://www.facebook.com/${FACEBOOK_API}/dialog/oauth?${q.toString()}`;
  }

  /**
   * Provider redirected back with `code`: exchange it with the store's secret, take the provider-VERIFIED
   * email, sign the buyer into THIS store (find by email else create), and hand the storefront a one-time code.
   * Always resolves to the URL to send the browser to — never throws once `state` is valid.
   */
  async handleCallback(provider: SocialProviderKey, storeId: string, code: string | undefined, stateToken: string | undefined, providerError?: string): Promise<{ redirectTo: string | null; error?: string }> {
    const state = this.verifyState(stateToken, provider);
    if (!state || state.storeId !== storeId) return { redirectTo: null, error: 'This sign-in link expired or is invalid. Please try again.' };
    const back = (query: Record<string, string>) => `${state.returnTo}/login?${new URLSearchParams(query).toString()}`;

    if (providerError || !code) return { redirectTo: back({ social_error: 'Sign-in was cancelled.' }) };
    try {
      const creds = await this.loadCredentials(state.storeId, provider);
      const identity = provider === 'google' ? await this.exchangeGoogle(code, creds, state.storeId) : await this.exchangeFacebook(code, creds, state.storeId);
      if (!identity.email) throw new UnauthorizedException(`Your ${provider === 'google' ? 'Google' : 'Facebook'} account did not share an email address, so we can't sign you in.`);

      const dto = {
        authProvider: provider, socialId: identity.id, email: identity.email, name: identity.name, image: identity.image,
        role: 'user', storeId: state.storeId,
      } as SocialLoginDto;
      const result = await this.authService.finishSocialLogin(dto, identity.email);
      await this.guestSessions.mergeFromAuthResult(result, state.storeId);

      const exchangeCode = randomBytes(24).toString('hex');
      await this.redisService.set(`social-exchange:${exchangeCode}`, JSON.stringify(result.data), EXCHANGE_CODE_TTL_S);
      return { redirectTo: `${state.returnTo}/login?social_code=${exchangeCode}` };
    } catch (err: any) {
      this.logger.warn(`Store social login (${provider}) failed for store ${state.storeId}: ${err?.message}`);
      const safe = err instanceof UnauthorizedException || err instanceof BadRequestException ? err.message : 'Sign-in failed. Please try again.';
      return { redirectTo: back({ social_error: safe }) };
    }
  }

  /** One-time swap of the short code in the redirect URL for the real tokens (so tokens never sit in a URL). */
  async exchange(code: string) {
    if (!code || typeof code !== 'string' || !/^[a-f0-9]{48}$/.test(code)) throw new UnauthorizedException('Invalid sign-in code');
    const key = `social-exchange:${code}`;
    const raw = await this.redisService.get(key);
    if (!raw) throw new UnauthorizedException('This sign-in link expired. Please try again.');
    await this.redisService.del(key);
    return { success: true, message: 'Social login successful', data: JSON.parse(raw) };
  }

  // ───────────────────────── internals ─────────────────────────

  private async loadCredentials(storeId: string, provider: SocialProviderKey): Promise<{ clientId: string; clientSecret: string }> {
    const row = await this.repos.storeIntegrationModel.findOne({ storeId, type: 'customer_login', provider: INTEGRATION_PROVIDER[provider], status: 'connected' });
    if (!row?.credentialsEncrypted) throw new BadRequestException(`${provider === 'google' ? 'Google' : 'Facebook'} sign-in is not enabled for this store`);
    return JSON.parse(decryptCredential(row.credentialsEncrypted, 'INTEGRATIONS'));
  }

  private async exchangeGoogle(code: string, creds: { clientId: string; clientSecret: string }, storeId: string) {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: creds.clientId, client_secret: creds.clientSecret,
        redirect_uri: this.redirectUri('google', storeId), grant_type: 'authorization_code',
      }).toString(),
    });
    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.id_token) throw new UnauthorizedException('Google sign-in could not be completed. Check the store\'s Google app settings.');
    // The id_token came straight from Google's token endpoint over TLS in exchange for OUR code + secret
    // (OpenID Connect core §3.1.3.7 lets the client skip signature checks in that case), so decoding is enough.
    const claims = JSON.parse(Buffer.from(String(data.id_token).split('.')[1], 'base64url').toString('utf8'));
    if (claims.aud !== creds.clientId || !claims.sub) throw new UnauthorizedException('Invalid Google sign-in response');
    return {
      id: String(claims.sub),
      email: claims.email_verified && claims.email ? String(claims.email).toLowerCase() : null,
      name: claims.name ? String(claims.name) : undefined,
      image: claims.picture ? String(claims.picture) : undefined,
    };
  }

  private async exchangeFacebook(code: string, creds: { clientId: string; clientSecret: string }, storeId: string) {
    const tokenQs = new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: this.redirectUri('facebook', storeId), code });
    const tokenResp = await fetch(`https://graph.facebook.com/${FACEBOOK_API}/oauth/access_token?${tokenQs.toString()}`);
    const tokenData: any = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok || !tokenData?.access_token) throw new UnauthorizedException('Facebook sign-in could not be completed. Check the store\'s Facebook app settings.');
    const meQs = new URLSearchParams({ fields: 'id,name,email,picture.width(200).height(200)', access_token: tokenData.access_token });
    const meResp = await fetch(`https://graph.facebook.com/${FACEBOOK_API}/me?${meQs.toString()}`);
    const me: any = await meResp.json().catch(() => ({}));
    if (!meResp.ok || !me?.id) throw new UnauthorizedException('Invalid Facebook sign-in response');
    return {
      id: String(me.id),
      email: me.email ? String(me.email).toLowerCase() : null,
      name: me.name ? String(me.name) : undefined,
      image: me.picture?.data?.url ? String(me.picture.data.url) : undefined,
    };
  }

  /** Every origin a buyer of this store can legitimately come from — the only places we will ever redirect back to. */
  private allowedOrigins(store: any): string[] {
    const hosts = [`${store.slug}.solvexo.store`];
    for (const d of store.customDomains ?? []) if (d?.status === 'verified' && d.domain) hosts.push(d.domain);
    const origins = hosts.map((h) => `https://${h}`);
    if (process.env.NODE_ENV !== 'production') origins.push(`http://${store.slug}.localhost:3000`, `http://${store.slug}.localhost:5173`);
    return origins;
  }

  private normalizeOrigin(value: string): string | null {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
    } catch {
      return null;
    }
  }

  private stateSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not set');
    return secret;
  }

  private signState(payload: StatePayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', this.stateSecret()).update(`social-state.${body}`).digest('base64url');
    return `${body}.${sig}`;
  }

  private verifyState(token: string | undefined, provider: SocialProviderKey): StatePayload | null {
    if (!token || typeof token !== 'string') return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = createHmac('sha256', this.stateSecret()).update(`social-state.${body}`).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
      if (payload.provider !== provider || payload.exp < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }
}
