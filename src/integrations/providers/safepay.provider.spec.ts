/* eslint-disable prettier/prettier */
import { createHmac } from 'crypto';
import { SafepayPaymentProvider } from './safepay.provider';
import { DecryptedPaymentConfig, PaymentOrderContext } from '../interfaces/payment-provider.interface';

const CREDENTIALS = { secretKey: 'sk_test_123', clientId: 'client_123', webhookSecret: 'whsec_test' };
const CONFIG: DecryptedPaymentConfig = { credentials: CREDENTIALS, config: { displayName: 'Safepay' }, mode: 'sandbox', webhookToken: 'tok' };
const ORDER: PaymentOrderContext = {
  orderId: 'checkout-1',
  amount: 1500,
  currency: 'PKR',
  storeId: 'store-1',
  returnUrl: 'https://example.com/return',
  cancelUrl: 'https://example.com/cancel',
};

function jsonResponse(body: any, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) } as any;
}

describe('SafepayPaymentProvider', () => {
  let provider: SafepayPaymentProvider;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    provider = new SafepayPaymentProvider();
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  describe('initiatePayment', () => {
    it('posts to the sandbox setup endpoint and builds a hosted-checkout redirect URL carrying the tracker token', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { tracker: { token: 'track_abc123', state: 'TRACKER_INITIATED' } } }));

      const session = await provider.initiatePayment(ORDER, CONFIG);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://sandbox.api.getsafepay.com/order/payments/v3/',
        expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-sfpy-merchant-secret': 'sk_test_123' }) }),
      );
      expect(session.sessionId).toBe('track_abc123');
      expect(session.redirectUrl).toContain('sandbox.api.getsafepay.com/embedded/');
      expect(session.redirectUrl).toContain('tracker=track_abc123');
      expect(session.redirectUrl).toContain('environment=sandbox');
    });

    it('uses the live host and secret when mode is live', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { tracker: { token: 'track_live1' } } }));
      await provider.initiatePayment(ORDER, { ...CONFIG, mode: 'live' });
      expect(fetchMock).toHaveBeenCalledWith('https://api.getsafepay.com/order/payments/v3/', expect.anything());
    });

    it('throws when Safepay does not return a tracker token', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: {} }));
      await expect(provider.initiatePayment(ORDER, CONFIG)).rejects.toThrow('did not include a tracker token');
    });

    it('throws with the gateway response body when the setup call fails', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ message: 'Invalid client' }, false, 400));
      await expect(provider.initiatePayment(ORDER, CONFIG)).rejects.toThrow('Safepay setup failed (400)');
    });
  });

  describe('verifyPayment', () => {
    it.each([
      ['TRACKER_ENDED', 'paid'],
      ['TRACKER_ABANDONED', 'failed'],
      ['TRACKER_ERROR', 'failed'],
      ['TRACKER_INITIATED', 'pending'],
    ])('maps tracker state %s to status %s', async (state, expected) => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { tracker: { state, token: 'track_1' } } }));
      const status = await provider.verifyPayment('track_1', CONFIG);
      expect(status.status).toBe(expected);
    });
  });

  describe('handleWebhook', () => {
    function signedBody(payload: object, secret = CREDENTIALS.webhookSecret) {
      const raw = Buffer.from(JSON.stringify(payload));
      const signature = createHmac('sha512', secret).update(raw).digest('hex');
      return { raw, signature };
    }

    it('accepts a correctly HMAC-SHA512-signed payload and reports payment_succeeded for a completed tracker', async () => {
      const payload = { id: 'evt_1', data: { tracker: { token: 'track_1', state: 'TRACKER_ENDED' } } };
      const { raw, signature } = signedBody(payload);

      const event = await provider.handleWebhook(raw, { 'x-sfpy-signature': signature }, CONFIG);

      expect(event.type).toBe('payment_succeeded');
      expect(event.externalEventId).toBe('evt_1');
      expect(event.sessionId).toBe('track_1');
    });

    it('rejects a payload with no signature header', async () => {
      const { raw } = signedBody({ data: { tracker: { token: 't' } } });
      await expect(provider.handleWebhook(raw, {}, CONFIG)).rejects.toThrow('Missing X-SFPY-SIGNATURE');
    });

    it('rejects a payload signed with the wrong secret (cross-store replay case)', async () => {
      const payload = { id: 'evt_2', data: { tracker: { token: 'track_1', state: 'TRACKER_ENDED' } } };
      const { raw, signature } = signedBody(payload, 'a-different-stores-webhook-secret');
      await expect(provider.handleWebhook(raw, { 'x-sfpy-signature': signature }, CONFIG)).rejects.toThrow('signature mismatch');
    });

    it('rejects a tampered payload even with a syntactically valid signature format', async () => {
      const { raw, signature } = signedBody({ id: 'evt_3', data: { tracker: { token: 'track_1', state: 'TRACKER_ENDED' } } });
      const tampered = Buffer.from(raw.toString('utf8').replace('TRACKER_ENDED', 'TRACKER_ABANDONED'));
      await expect(provider.handleWebhook(tampered, { 'x-sfpy-signature': signature }, CONFIG)).rejects.toThrow('signature mismatch');
    });
  });

  describe('refund', () => {
    it('returns a succeeded result on a 2xx response', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { id: 'refund_1' } }));
      const result = await provider.refund('track_1', 500, CONFIG);
      expect(result).toEqual({ success: true, refundId: 'refund_1', amount: 500, status: 'succeeded' });
    });

    it('returns a failed result without throwing when the gateway rejects the refund', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ message: 'Already refunded' }, false, 409));
      const result = await provider.refund('track_1', 500, CONFIG);
      expect(result.success).toBe(false);
      expect(result.status).toBe('failed');
    });
  });

  describe('getPublicConfig', () => {
    it('never includes credentials, only safe display fields', () => {
      const view = provider.getPublicConfig({ displayName: 'My Safepay', logo: 'x.png' });
      expect(view).toEqual({ displayName: 'My Safepay', currency: 'PKR', logo: 'x.png' });
    });
  });
});
