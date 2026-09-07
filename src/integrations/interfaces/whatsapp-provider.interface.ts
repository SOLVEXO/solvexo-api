/* eslint-disable prettier/prettier */

/**
 * Only the token exchange result — `waba_id`/`phone_number_id`/`business_id`
 * are NOT obtainable from this call. Per Meta's own Embedded Signup flow,
 * those ids arrive client-side via the frontend's `WA_EMBEDDED_SIGNUP`
 * postMessage event listener, not the server-side code exchange. The
 * seller-facing connect endpoint (Phase 6) is responsible for accepting
 * both `code` and those ids from the request body and combining them into
 * one `StoreIntegration` — this provider only ever does the token half.
 */
export interface WhatsAppConnectionResult {
  accessToken: string;
  /** null = never expires (Meta System User tokens issued via Embedded Signup typically don't) — `checkTokenValidity` is the actual source of truth either way. */
  expiresAt: Date | null;
}

export interface WhatsAppTokenValidity {
  isValid: boolean;
  expiresAt: Date | null;
}

export interface WhatsAppTemplateMessage {
  templateName: string;
  languageCode: string;
  /** Positional {{1}}, {{2}}... params for the template body — the common case; named/media params aren't modeled here yet. */
  bodyParams?: string[];
}

export interface WhatsAppSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface WhatsAppIncomingEvent {
  type: 'message_status' | 'inbound_message' | 'unknown';
  phoneNumberId: string | null;
  raw: Record<string, any>;
}

export interface DecryptedWhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
}

export interface WhatsAppProvider {
  exchangeAuthCode(code: string): Promise<WhatsAppConnectionResult>;
  /** Proves the token actually has access to this phone number before it's trusted for anything — see WhatsAppCloudProvider's implementation doc. */
  verifyPhoneNumberAccess(accessToken: string, phoneNumberId: string): Promise<{ verified: boolean; wabaId: string | null }>;
  checkTokenValidity(accessToken: string): Promise<WhatsAppTokenValidity>;
  sendTemplateMessage(config: DecryptedWhatsAppConfig, to: string, message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult>;
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean;
  parseWebhookPayload(rawBody: Buffer): WhatsAppIncomingEvent;
}
