/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  DecryptedPaymentConfig,
  PaymentEvent,
  PaymentOrderContext,
  PaymentProvider,
  PaymentSession,
  PaymentStatus,
  RefundResult,
} from '../interfaces/payment-provider.interface';

/**
 * Safepay (getsafepay.com) — Pakistan payment gateway, PKR only.
 *
 * Endpoints, auth header, and webhook signature scheme below are verified
 * against Safepay's own official SDK source (github.com/getsafepay/node-core,
 * inspected directly: src/resources/Payments/Session.ts, Order/{Tracker,
 * Cancel}.ts, RequestSender.ts) and their public webhook docs
 * (safepay-docs.netlify.app/developers/webhooks/verify-hmac-signatures).
 *
 * NOT independently verified — flagged for the team to confirm against a
 * real sandbox account before going live: the exact JSON body field names
 * for the "setup" (create tracker) call, and the full set of query params
 * required by the hosted-checkout redirect beyond `tracker`/`environment`
 * (their SDK's `createCheckoutUrl` type also lists `tbt`, `source`,
 * `order_id`, `redirect_url`, `cancel_url` — `tbt` in particular is
 * unexplained in the SDK and needs confirming from a live `setup` response
 * before this is wired to real traffic). The body shape below is our best
 * inference; update `buildSetupPayload` once confirmed.
 */
@Injectable()
export class SafepayPaymentProvider implements PaymentProvider {
  readonly providerKey = 'safepay' as const;
  private readonly logger = new Logger(SafepayPaymentProvider.name);

  private apiBase(mode: 'sandbox' | 'live'): string {
    return mode === 'live' ? 'https://api.getsafepay.com' : 'https://sandbox.api.getsafepay.com';
  }

  private checkoutBase(mode: 'sandbox' | 'live'): string {
    return mode === 'live' ? 'https://getsafepay.com/embedded/' : 'https://sandbox.api.getsafepay.com/embedded/';
  }

  private authHeaders(config: DecryptedPaymentConfig): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-sfpy-merchant-secret': config.credentials.secretKey,
    };
  }

  /**
   * Real test: creates a throw-away tracker (PKR 1, never paid, never redirected to) with the seller's own
   * credentials in the selected mode, then reads it back. 401/403 = wrong keys for this mode.
   */
  async testConnection(config: DecryptedPaymentConfig) {
    if (!config.credentials?.secretKey || !config.credentials?.clientId) {
      return { ok: false, message: 'Safepay secret key / client id are missing' };
    }
    try {
      const res = await fetch(`${this.apiBase(config.mode)}/order/payments/v3/`, {
        method: 'POST',
        headers: this.authHeaders(config),
        body: JSON.stringify({
          client: config.credentials.clientId,
          amount: 1,
          currency: 'PKR',
          environment: config.mode,
          order_id: `solvexo-connection-test-${Date.now()}`,
        }),
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: `Safepay rejected these credentials in ${config.mode} mode (HTTP ${res.status}) — check the keys belong to ${config.mode}` };
      }
      if (!res.ok) {
        return { ok: false, message: `Safepay returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
      }
      const data = await res.json();
      const token: string | undefined = (data?.data?.tracker ?? data?.data ?? data)?.token;
      if (!token) return { ok: false, message: 'Safepay answered but did not return a tracker token' };
      const check = await this.verifyPayment(token, config);
      return { ok: true, message: `Safepay ${config.mode} credentials accepted (test tracker ${token.slice(0, 8)}…, state ${check.status})` };
    } catch (err: any) {
      return { ok: false, message: `Could not reach Safepay: ${err?.message ?? 'network error'}` };
    }
  }

  async initiatePayment(order: PaymentOrderContext, config: DecryptedPaymentConfig): Promise<PaymentSession> {
    const res = await fetch(`${this.apiBase(config.mode)}/order/payments/v3/`, {
      method: 'POST',
      headers: this.authHeaders(config),
      body: JSON.stringify({
        client: config.credentials.clientId,
        amount: order.amount,
        currency: order.currency,
        environment: config.mode,
        order_id: order.orderId,
      }),
    });
    if (!res.ok) {
      throw new Error(`Safepay setup failed (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    const tracker = data?.data?.tracker ?? data?.data ?? data;
    const token: string | undefined = tracker?.token;
    if (!token) {
      throw new Error('Safepay setup response did not include a tracker token');
    }

    const redirectUrl = new URL(this.checkoutBase(config.mode));
    redirectUrl.searchParams.set('environment', config.mode);
    redirectUrl.searchParams.set('tracker', token);
    redirectUrl.searchParams.set('source', 'hosted');
    redirectUrl.searchParams.set('order_id', order.orderId);
    redirectUrl.searchParams.set('redirect_url', order.returnUrl);
    redirectUrl.searchParams.set('cancel_url', order.cancelUrl);
    if (tracker?.tbt) redirectUrl.searchParams.set('tbt', tracker.tbt);

    return { redirectUrl: redirectUrl.toString(), sessionId: token };
  }

  async verifyPayment(reference: string, config: DecryptedPaymentConfig): Promise<PaymentStatus> {
    const res = await fetch(`${this.apiBase(config.mode)}/order/payments/v3/${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: this.authHeaders(config),
    });
    if (!res.ok) {
      throw new Error(`Safepay tracker lookup failed (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    const tracker = data?.data?.tracker ?? data?.data ?? data;
    return {
      status: this.mapTrackerState(tracker?.state),
      providerReference: reference,
      amount: tracker?.amount,
      currency: 'PKR',
      raw: tracker,
    };
  }

  private mapTrackerState(state: string | undefined): PaymentStatus['status'] {
    switch (state) {
      case 'TRACKER_ENDED':
        return 'paid';
      case 'TRACKER_ABANDONED':
      case 'TRACKER_ERROR':
        return 'failed';
      default:
        return 'pending';
    }
  }

  /**
   * Verifies `X-SFPY-SIGNATURE` (HMAC-SHA512 of the raw JSON body, keyed by
   * the store's own webhook secret — per-store secret keeps a leaked
   * signature from one store's gateway account from validating against
   * another's).
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- HMAC verification is synchronous; async to satisfy the shared PaymentProvider interface
  async handleWebhook(rawBody: Buffer, headers: Record<string, string>, config: DecryptedPaymentConfig): Promise<PaymentEvent> {
    const signature = headers['x-sfpy-signature'] ?? headers['X-SFPY-SIGNATURE'];
    if (!signature) {
      throw new Error('Missing X-SFPY-SIGNATURE header');
    }
    const expected = createHmac('sha512', config.credentials.webhookSecret).update(rawBody).digest('hex');
    const signatureBuf = Buffer.from(signature, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (signatureBuf.length !== expectedBuf.length || !timingSafeEqual(signatureBuf, expectedBuf)) {
      throw new Error('Safepay webhook signature mismatch');
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    const tracker = payload?.data?.tracker ?? payload?.tracker ?? payload;
    const eventId: string | undefined = payload?.id ?? payload?.event_id ?? `${tracker?.token}:${tracker?.state}`;
    const status = this.mapTrackerState(tracker?.state);

    return {
      // Only a terminal state may finalize an order. A non-terminal tracker
      // state (e.g. TRACKER_STARTED) maps to `pending` and must NEVER be
      // treated as a successful payment.
      type: status === 'paid' ? 'payment_succeeded' : status === 'failed' ? 'payment_failed' : 'payment_pending',
      externalEventId: String(eventId),
      sessionId: tracker?.token,
      status: { status, providerReference: tracker?.token, currency: 'PKR', raw: payload },
    };
  }

  async refund(transactionId: string, amount: number, config: DecryptedPaymentConfig): Promise<RefundResult> {
    const res = await fetch(`${this.apiBase(config.mode)}/order/payments/v3/${encodeURIComponent(transactionId)}/refund`, {
      method: 'POST',
      headers: this.authHeaders(config),
      body: JSON.stringify({ amount }),
    });
    if (!res.ok) {
      this.logger.warn(`Safepay refund failed for ${transactionId} (${res.status}): ${await res.text()}`);
      return { success: false, refundId: '', amount, status: 'failed' };
    }
    const data = await res.json();
    return {
      success: true,
      refundId: data?.data?.id ?? data?.data?.token ?? transactionId,
      amount,
      status: 'succeeded',
    };
  }

  getPublicConfig(config: Record<string, any>) {
    return {
      displayName: config.displayName ?? 'Safepay',
      currency: 'PKR' as const,
      logo: config.logo,
    };
  }
}
