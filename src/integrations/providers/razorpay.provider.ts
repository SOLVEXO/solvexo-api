/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { fromStripeAmount, toStripeAmount } from '../../common/stripe-amount.util';
import {
  ConnectionTestResult,
  DecryptedPaymentConfig,
  PaymentEvent,
  PaymentOrderContext,
  PaymentProvider,
  PaymentSession,
  PaymentStatus,
  RefundResult,
} from '../interfaces/payment-provider.interface';

/**
 * Razorpay HOSTED payment through Payment Links, with the SELLER'S OWN key id / key secret (HTTP Basic) against
 * https://api.razorpay.com/v1. The buyer is redirected to the link's `short_url`; the platform never touches the money.
 * The key id prefix (rzp_test_ / rzp_live_) already selects the mode, there is no separate sandbox host.
 *
 * Amounts are integers in the currency's smallest unit (paise for INR). The conversion reuses the shared minor-unit
 * helper (x100 for INR/USD/..., x1 for zero-decimal, x1000 for 3-decimal currencies), which matches Razorpay's rules
 * for the currencies the catalog offers (INR only today).
 *
 * Doc pages checked 2026-10-26:
 *  - https://razorpay.com/docs/api/payments/payment-links/create-standard/
 *  - https://razorpay.com/docs/webhooks/payloads/payment-links/
 *  - https://razorpay.com/docs/webhooks/validate-test/
 *  - https://razorpay.com/docs/api/refunds/create-normal/
 * VERIFIED in those docs: create fields (amount, currency, reference_id <= 40 chars unique, expire_by >= 15 min ahead
 * and <= 6 months, callback_url + callback_method 'get', notify, reminder_enable, customer.email/contact), response
 * (id plink_*, short_url, status created|partially_paid|expired|cancelled|paid, amount_paid, `payments[]` with
 * `payment_id` after a capture, null before), webhook events payment_link.paid/cancelled/expired and their payload
 * objects, `X-Razorpay-Signature` = HMAC-SHA256(webhook secret, raw body), `x-razorpay-event-id` header, refund
 * endpoint POST /payments/:id/refund {amount, speed} with status pending|processed|failed.
 * INFERRED / unsure: `GET /payments?count=1` as the harmless credential probe (standard list endpoint, not re-read
 * on a docs page); that the fetch-link response carries the same `payments[]` as the create response; contact
 * number format (we only send digits with a leading +, or leave it out).
 *
 * NOT run against a live/sandbox Razorpay account.
 */
@Injectable()
export class RazorpayPaymentProvider implements PaymentProvider {
  readonly providerKey = 'razorpay' as const;
  // Status is always re-read from the authenticated fetch-link call, the webhook only triggers it.
  readonly callbackIsAuthoritative = false;
  private readonly logger = new Logger(RazorpayPaymentProvider.name);
  private static readonly BASE = 'https://api.razorpay.com/v1';

  private creds(config: DecryptedPaymentConfig) {
    const { keyId, keySecret } = config.credentials ?? {};
    if (!keyId || !keySecret) throw new Error('Razorpay key id and key secret are required');
    return { keyId: String(keyId), keySecret: String(keySecret) };
  }

  private async call(config: DecryptedPaymentConfig, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<{ status: number; ok: boolean; data: Record<string, any> }> {
    const { keyId, keySecret } = this.creds(config);
    const res = await fetch(`${RazorpayPaymentProvider.BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64')}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let data: Record<string, any> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 200) };
    }
    return { status: res.status, ok: res.ok, data };
  }

  private static errorText(data: Record<string, any>, status: number): string {
    return `HTTP ${status}: ${String(data?.error?.description ?? data?.raw ?? 'request rejected').slice(0, 200)}`;
  }

  async testConnection(config: DecryptedPaymentConfig): Promise<ConnectionTestResult> {
    try {
      const { keyId } = this.creds(config);
      const keyMode = keyId.startsWith('rzp_test_') ? 'test' : keyId.startsWith('rzp_live_') ? 'live' : null;
      const r = await this.call(config, 'GET', '/payments?count=1');
      if (r.status === 401) {
        return { ok: false, message: `Razorpay rejected the key id / key secret${keyMode ? ` (these are ${keyMode}-mode keys: make sure the secret belongs to the same ${keyMode} key)` : ''}.` };
      }
      if (!r.ok) return { ok: false, message: `Razorpay answered with an error (${RazorpayPaymentProvider.errorText(r.data, r.status)})` };
      return { ok: true, message: `Connected to Razorpay${keyMode ? ` (${keyMode} mode)` : ''}.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Could not reach Razorpay' };
    }
  }

  async initiatePayment(order: PaymentOrderContext, config: DecryptedPaymentConfig): Promise<PaymentSession> {
    this.creds(config);
    if (!(order.amount > 0)) throw new Error('Nothing to pay');
    const currency = order.currency.toUpperCase();
    const minor = toStripeAmount(order.amount, currency);
    if (!(minor > 0)) throw new Error('Nothing to pay');
    // reference_id: unique per payment link, <= 40 chars.
    const referenceId = `${String(order.orderId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 30)}-${randomBytes(4).toString('hex')}`.slice(0, 40);
    const customer: Record<string, string> = {};
    if (order.buyerName) customer.name = order.buyerName.slice(0, 100);
    if (order.buyerEmail) customer.email = order.buyerEmail;
    const contact = String(order.buyerPhone ?? '').replace(/[^\d+]/g, '');
    if (contact.replace(/\D/g, '').length >= 8 && contact.length <= 14) customer.contact = contact;

    const r = await this.call(config, 'POST', '/payment_links', {
      amount: minor,
      currency,
      reference_id: referenceId,
      description: `Order ${order.orderId}`.slice(0, 2000),
      customer,
      notify: { sms: false, email: false },
      reminder_enable: false,
      callback_url: order.returnUrl,
      callback_method: 'get',
      // docs: at least 15 minutes ahead, at most 6 months; we use 2 days.
      expire_by: Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60,
    });
    if (!r.ok || !r.data.id || !r.data.short_url) {
      throw new Error(`Razorpay could not start the payment (${RazorpayPaymentProvider.errorText(r.data, r.status)})`);
    }
    return { redirectUrl: String(r.data.short_url), sessionId: String(r.data.id) };
  }

  async verifyPayment(sessionId: string, config: DecryptedPaymentConfig): Promise<PaymentStatus> {
    const r = await this.call(config, 'GET', `/payment_links/${encodeURIComponent(sessionId)}`);
    if (!r.ok) throw new Error(`Razorpay payment link lookup failed (${RazorpayPaymentProvider.errorText(r.data, r.status)})`);
    const link = r.data;
    const currency = link.currency ? String(link.currency).toUpperCase() : undefined;
    const raw = { id: link.id, status: link.status, amount: link.amount, amount_paid: link.amount_paid };
    if (link.status === 'paid') {
      const payments: any[] = Array.isArray(link.payments) ? link.payments : [];
      const captured = payments.find((p) => p?.payment_id && (!p.status || p.status === 'captured')) ?? payments.find((p) => p?.payment_id);
      return {
        status: 'paid',
        providerReference: String(link.id ?? sessionId),
        paymentId: captured?.payment_id ? String(captured.payment_id) : undefined,
        amount: fromStripeAmount(link.amount_paid, currency),
        currency,
        raw,
      };
    }
    if (link.status === 'cancelled' || link.status === 'expired') {
      return { status: 'failed', providerReference: String(link.id ?? sessionId), currency, raw };
    }
    // created / partially_paid / anything unknown: not done yet.
    return { status: 'pending', providerReference: String(link.id ?? sessionId), currency, raw };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- signature check + parsing only
  async handleWebhook(rawBody: Buffer, headers: Record<string, string>, config: DecryptedPaymentConfig): Promise<PaymentEvent> {
    const secret = config.credentials?.webhookSecret;
    if (!secret) throw new Error('Razorpay webhook secret is not configured');
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers ?? {})) lower[k.toLowerCase()] = String(v);
    const signature = lower['x-razorpay-signature'];
    if (!signature) throw new Error('Missing Razorpay signature header');
    const expected = createHmac('sha256', String(secret)).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature.trim(), 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Invalid Razorpay webhook signature');

    let body: Record<string, any>;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new Error('Razorpay webhook body is not valid JSON');
    }
    const event = String(body.event ?? '');
    const link = body.payload?.payment_link?.entity ?? {};
    const payment = body.payload?.payment?.entity ?? {};
    const sessionId = String(link.id ?? '');
    const entityId = String(payment.id ?? link.id ?? '');
    const externalEventId = lower['x-razorpay-event-id'] || `${event}:${entityId}`;
    const currency = String(payment.currency ?? link.currency ?? '').toUpperCase() || undefined;

    if (event === 'payment_link.paid') {
      return {
        type: 'payment_succeeded',
        externalEventId,
        sessionId,
        status: {
          status: 'paid',
          providerReference: sessionId,
          paymentId: payment.id ? String(payment.id) : undefined,
          amount: fromStripeAmount(payment.amount ?? link.amount_paid, currency),
          currency,
        },
      };
    }
    if (event === 'payment_link.cancelled' || event === 'payment_link.expired') {
      return { type: 'payment_failed', externalEventId, sessionId, status: { status: 'failed', providerReference: sessionId, currency } };
    }
    return { type: 'payment_pending', externalEventId, sessionId, status: { status: 'pending', providerReference: sessionId, currency } };
  }

  async refund(paymentId: string, amount: number, config: DecryptedPaymentConfig): Promise<RefundResult> {
    const fail: RefundResult = { success: false, refundId: '', amount, status: 'failed' };
    try {
      const minor = toStripeAmount(amount, config.config?.currency ?? 'INR');
      const r = await this.call(config, 'POST', `/payments/${encodeURIComponent(paymentId)}/refund`, { amount: minor, speed: 'normal' });
      if (!r.ok || !r.data.id) {
        this.logger.warn(`Razorpay refund for ${paymentId} rejected (${RazorpayPaymentProvider.errorText(r.data, r.status)})`);
        return fail;
      }
      const cur = r.data.currency ? String(r.data.currency) : 'INR';
      const refunded = fromStripeAmount(r.data.amount ?? minor, cur);
      if (r.data.status === 'processed') return { success: true, refundId: String(r.data.id), amount: refunded, status: 'succeeded' };
      if (r.data.status === 'failed') return { success: false, refundId: String(r.data.id), amount: refunded, status: 'failed' };
      return { success: true, refundId: String(r.data.id), amount: refunded, status: 'pending' };
    } catch (err) {
      this.logger.warn(`Razorpay refund for ${paymentId} failed: ${err instanceof Error ? err.message : String(err)}`);
      return fail;
    }
  }

  getPublicConfig(config: Record<string, any>) {
    return { displayName: config.displayName ?? 'Razorpay', currency: config.currency ?? '', logo: config.logo };
  }
}
