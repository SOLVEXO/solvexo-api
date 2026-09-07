/* eslint-disable prettier/prettier */
import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { WhatsAppCloudProvider } from './whatsapp-cloud.provider';
import { DecryptedWhatsAppConfig } from '../interfaces/whatsapp-provider.interface';

const APP_ID = 'app-123';
const APP_SECRET = 'app-secret-xyz';

function jsonResponse(body: any, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) } as any;
}

describe('WhatsAppCloudProvider', () => {
  let provider: WhatsAppCloudProvider;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    const configService = {
      get: (key: string) => (key === 'META_APP_ID' ? APP_ID : key === 'META_APP_SECRET' ? APP_SECRET : undefined),
    } as unknown as ConfigService;
    provider = new WhatsAppCloudProvider(configService);
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  describe('exchangeAuthCode', () => {
    it('exchanges the Embedded Signup code for an access token via the documented GET oauth endpoint', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ access_token: 'EAAtoken123', token_type: 'bearer' }));
      const result = await provider.exchangeAuthCode('short-lived-code');

      const calledUrl = new URL(fetchMock.mock.calls[0][0]);
      expect(calledUrl.origin + calledUrl.pathname).toBe('https://graph.facebook.com/v21.0/oauth/access_token');
      expect(calledUrl.searchParams.get('client_id')).toBe(APP_ID);
      expect(calledUrl.searchParams.get('client_secret')).toBe(APP_SECRET);
      expect(calledUrl.searchParams.get('code')).toBe('short-lived-code');
      expect(result.accessToken).toBe('EAAtoken123');
      expect(result.expiresAt).toBeNull();
    });

    it('throws if the exchange response has no access_token', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));
      await expect(provider.exchangeAuthCode('code')).rejects.toThrow('did not include an access_token');
    });
  });

  describe('verifyPhoneNumberAccess (Phase 8 security fix — never trust a client-claimed phoneNumberId)', () => {
    it('reports verified with the WABA id when Meta confirms the token can access this phone number', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: '1234567890', whatsapp_business_account: { id: 'waba-999' } }));
      const result = await provider.verifyPhoneNumberAccess('EAAtoken', '1234567890');
      expect(result).toEqual({ verified: true, wabaId: 'waba-999' });
    });

    it('reports not verified when Meta rejects the token/phone number pair (the attack this closes)', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'Unsupported get request' } }, false, 400));
      const result = await provider.verifyPhoneNumberAccess('attackers-own-token', 'victim-phone-number-id');
      expect(result).toEqual({ verified: false, wabaId: null });
    });

    it('reports not verified if the returned id does not match the requested phoneNumberId', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 'some-other-id', whatsapp_business_account: { id: 'waba-1' } }));
      const result = await provider.verifyPhoneNumberAccess('token', '1234567890');
      expect(result.verified).toBe(false);
    });
  });

  describe('checkTokenValidity', () => {
    it('treats expires_at: 0 as never-expiring', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { is_valid: true, expires_at: 0 } }));
      const result = await provider.checkTokenValidity('token');
      expect(result).toEqual({ isValid: true, expiresAt: null });
    });

    it('converts a non-zero expires_at (unix seconds) to a Date', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { is_valid: true, expires_at: 1700000000 } }));
      const result = await provider.checkTokenValidity('token');
      expect(result.expiresAt?.getTime()).toBe(1700000000 * 1000);
    });

    it('reports invalid without throwing when the debug_token call itself fails', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, false, 401));
      const result = await provider.checkTokenValidity('revoked-token');
      expect(result).toEqual({ isValid: false, expiresAt: null });
    });
  });

  describe('sendTemplateMessage', () => {
    const config: DecryptedWhatsAppConfig = { accessToken: 'token', phoneNumberId: 'pn-1', wabaId: 'waba-1' };

    it('sends a positional-params template message and returns the message id', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ messages: [{ id: 'wamid.123' }] }));
      const result = await provider.sendTemplateMessage(config, '+923001234567', {
        templateName: 'order_shipped',
        languageCode: 'en_US',
        bodyParams: ['ORD-1', 'TCS'],
      });

      expect(result).toEqual({ success: true, messageId: 'wamid.123' });
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://graph.facebook.com/v21.0/pn-1/messages');
      const body = JSON.parse(options.body);
      expect(body.template.components[0].parameters).toEqual([{ type: 'text', text: 'ORD-1' }, { type: 'text', text: 'TCS' }]);
    });

    it('returns a failure result without throwing when the send fails', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'Template not approved' } }, false, 400));
      const result = await provider.sendTemplateMessage(config, '+923001234567', { templateName: 'x', languageCode: 'en_US' });
      expect(result.success).toBe(false);
    });
  });

  describe('verifyWebhookSignature', () => {
    it('accepts a correctly HMAC-SHA256-signed body', () => {
      const raw = Buffer.from(JSON.stringify({ entry: [] }));
      const signature = 'sha256=' + createHmac('sha256', APP_SECRET).update(raw).digest('hex');
      expect(provider.verifyWebhookSignature(raw, signature)).toBe(true);
    });

    it('rejects a body signed with a different app secret', () => {
      const raw = Buffer.from(JSON.stringify({ entry: [] }));
      const signature = 'sha256=' + createHmac('sha256', 'wrong-secret').update(raw).digest('hex');
      expect(provider.verifyWebhookSignature(raw, signature)).toBe(false);
    });

    it('rejects a missing or malformed signature header', () => {
      const raw = Buffer.from('{}');
      expect(provider.verifyWebhookSignature(raw, undefined)).toBe(false);
      expect(provider.verifyWebhookSignature(raw, 'not-sha256-prefixed')).toBe(false);
    });
  });

  describe('parseWebhookPayload', () => {
    it('extracts phoneNumberId and classifies a status update', () => {
      const raw = Buffer.from(
        JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn-1' }, statuses: [{ id: 's1' }] } }] }] }),
      );
      const event = provider.parseWebhookPayload(raw);
      expect(event).toEqual({ type: 'message_status', phoneNumberId: 'pn-1', raw: expect.anything() });
    });

    it('classifies an inbound message', () => {
      const raw = Buffer.from(
        JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn-1' }, messages: [{ id: 'm1' }] } }] }] }),
      );
      expect(provider.parseWebhookPayload(raw).type).toBe('inbound_message');
    });

    it('treats a non-string phone_number_id as absent rather than trusting it (defense-in-depth from the Phase 8 review)', () => {
      const raw = Buffer.from(
        JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: { $ne: null } }, statuses: [] } }] }] }),
      );
      expect(provider.parseWebhookPayload(raw).phoneNumberId).toBeNull();
    });
  });
});
