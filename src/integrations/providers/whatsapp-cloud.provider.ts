/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  DecryptedWhatsAppConfig,
  WhatsAppConnectionResult,
  WhatsAppIncomingEvent,
  WhatsAppProvider,
  WhatsAppSendResult,
  WhatsAppTemplateMessage,
  WhatsAppTokenValidity,
} from '../interfaces/whatsapp-provider.interface';

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Meta WhatsApp Cloud API — the only WhatsApp provider, per Phase 2
 * sign-off (official Business API only, no third-party/unofficial clients).
 *
 * Endpoint shapes, the token-exchange call, and the webhook signature scheme
 * below are verified directly against developers.facebook.com (fetched
 * during Phase 5, not recalled from memory): the messages endpoint, the
 * `GET {base}/oauth/access_token` code exchange, `X-Hub-Signature-256`
 * (HMAC-SHA256 over the raw body, keyed by the platform App Secret — NOT a
 * per-store secret, see the webhook controller's class doc for why that
 * differs from the payment gateways), and the `debug_token` validity check.
 */
@Injectable()
export class WhatsAppCloudProvider implements WhatsAppProvider {
  private readonly logger = new Logger(WhatsAppCloudProvider.name);

  constructor(private readonly configService: ConfigService) {}

  private get appId(): string | undefined {
    return this.configService.get<string>('META_APP_ID');
  }

  private get appSecret(): string | undefined {
    return this.configService.get<string>('META_APP_SECRET');
  }

  async exchangeAuthCode(code: string): Promise<WhatsAppConnectionResult> {
    if (!this.appId || !this.appSecret) {
      throw new Error('META_APP_ID / META_APP_SECRET are not configured on this platform.');
    }
    const url = new URL(`${GRAPH_API_BASE}/oauth/access_token`);
    url.searchParams.set('client_id', this.appId);
    url.searchParams.set('client_secret', this.appSecret);
    url.searchParams.set('code', code);

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`WhatsApp token exchange failed (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    if (!data.access_token) {
      throw new Error('WhatsApp token exchange response did not include an access_token');
    }
    return {
      accessToken: data.access_token,
      expiresAt: typeof data.expires_in === 'number' ? new Date(Date.now() + data.expires_in * 1000) : null,
    };
  }

  /**
   * `debug_token` is the source of truth for whether a stored token still
   * works — used both right after connecting (to confirm) and by the
   * scheduled refresh check (to catch a token the seller revoked in Meta
   * Business Manager rather than through us).
   */
  async checkTokenValidity(accessToken: string): Promise<WhatsAppTokenValidity> {
    if (!this.appId || !this.appSecret) {
      throw new Error('META_APP_ID / META_APP_SECRET are not configured on this platform.');
    }
    const url = new URL(`${GRAPH_API_BASE}/debug_token`);
    url.searchParams.set('input_token', accessToken);
    url.searchParams.set('access_token', `${this.appId}|${this.appSecret}`);

    const res = await fetch(url.toString());
    if (!res.ok) {
      return { isValid: false, expiresAt: null };
    }
    const data = await res.json();
    const info = data?.data ?? {};
    return {
      isValid: !!info.is_valid,
      // Meta returns 0 for "never expires" (System User tokens from Embedded Signup).
      expiresAt: info.expires_at ? new Date(info.expires_at * 1000) : null,
    };
  }

  async sendTemplateMessage(config: DecryptedWhatsAppConfig, to: string, message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult> {
    const res = await fetch(`${GRAPH_API_BASE}/${config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: message.templateName,
          language: { code: message.languageCode },
          ...(message.bodyParams?.length
            ? { components: [{ type: 'body', parameters: message.bodyParams.map((text) => ({ type: 'text', text })) }] }
            : {}),
        },
      }),
    });
    if (!res.ok) {
      const error = await res.text();
      this.logger.warn(`WhatsApp send failed for ${config.phoneNumberId} -> ${to}: ${error}`);
      return { success: false, error };
    }
    const data = await res.json();
    return { success: true, messageId: data?.messages?.[0]?.id };
  }

  /** `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 over the raw body, keyed by the platform App Secret (shared across all stores — see class doc). */
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    if (!signatureHeader?.startsWith('sha256=')) return false;
    if (!this.appSecret) return false;
    const provided = signatureHeader.slice('sha256='.length);
    const expected = createHmac('sha256', this.appSecret).update(rawBody).digest('hex');
    const providedBuf = Buffer.from(provided, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
  }

  /**
   * Unlike the payment gateways, WhatsApp Cloud API has no per-store
   * webhook URL — every store's events arrive at ONE app-level endpoint, so
   * attribution is payload-based: `entry[].changes[].value.metadata.phone_number_id`
   * identifies which store's `StoreIntegration` this event belongs to.
   */
  parseWebhookPayload(rawBody: Buffer): WhatsAppIncomingEvent {
    const payload = JSON.parse(rawBody.toString('utf8'));
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    // Defense-in-depth: the signature check above already restricts this
    // payload to something Meta actually signed, but never let an
    // attacker-shaped value (e.g. a NoSQL-operator object smuggled in place
    // of a string) reach the `config.phoneNumberId` lookup this feeds —
    // only a genuine string is ever treated as an id.
    const rawPhoneNumberId = value?.metadata?.phone_number_id;
    const phoneNumberId: string | null = typeof rawPhoneNumberId === 'string' ? rawPhoneNumberId : null;
    const type: WhatsAppIncomingEvent['type'] = value?.statuses ? 'message_status' : value?.messages ? 'inbound_message' : 'unknown';
    return { type, phoneNumberId, raw: payload };
  }

  /**
   * Proves the exchanged token actually has access to `phoneNumberId`
   * before we ever trust it — without this, `connectWhatsApp` would store
   * whatever `phoneNumberId` the seller's own request body claims, and
   * since inbound webhook routing matches purely on
   * `StoreIntegration.config.phoneNumberId`, an unverified claim could
   * hijack or collide with another store's real WhatsApp number. Returns
   * Meta's own authoritative `whatsapp_business_account` id too, so the
   * caller never has to trust the client-supplied `wabaId` either.
   */
  async verifyPhoneNumberAccess(accessToken: string, phoneNumberId: string): Promise<{ verified: boolean; wabaId: string | null }> {
    const url = new URL(`${GRAPH_API_BASE}/${phoneNumberId}`);
    url.searchParams.set('fields', 'id,whatsapp_business_account');
    url.searchParams.set('access_token', accessToken);

    const res = await fetch(url.toString());
    if (!res.ok) return { verified: false, wabaId: null };
    const data = await res.json();
    return { verified: data?.id === phoneNumberId, wabaId: data?.whatsapp_business_account?.id ?? null };
  }
}
