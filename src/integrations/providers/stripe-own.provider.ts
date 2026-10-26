/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
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

const STRIPE_API = 'https://api.stripe.com';
const TIMEOUT_MS = 20_000;
/** Stripe's own default tolerance for webhook timestamps. */
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * Stripe Checkout (hosted page) with the SELLER'S OWN Stripe secret key — NOT Stripe Connect. The money goes
 * straight from the buyer to the seller's own Stripe account; the platform never touches it. Plain REST
 * (`Authorization: Bearer <secretKey>`, form-encoded bodies), no Stripe SDK, no pinned `Stripe-Version`.
 *
 * Flow: `initiatePayment` creates a Checkout Session and returns its hosted `url`; the buyer comes back to
 * `success_url` with `?session_id=cs_...`; the result is ALWAYS read from the authenticated Retrieve Session call
 * (`verifyPayment`). The signed webhook is only a trigger — `callbackIsAuthoritative = false`, so the webhook
 * handler re-asks the gateway before finalizing.
 *
 * VERIFIED in the official docs (fetched 2026-10-26):
 *  - https://docs.stripe.com/api/checkout/sessions/create — `mode=payment`, `success_url`, `cancel_url`,
 *    `client_reference_id`, `customer_email`, `metadata`, `line_items` (price_data form fields), response `id`/`url`/
 *    `payment_status`/`amount_total`/`currency`.
 *  - https://docs.stripe.com/webhooks (manual verification) — `Stripe-Signature: t=...,v1=...[,v1=...][,v0=...]`,
 *    signed payload = `${t}.${rawBody}`, HMAC-SHA256 with the endpoint secret, ignore non-`v1` schemes, constant-time
 *    compare, 5 minute default tolerance, several `v1` values while a secret is being rolled.
 * INFERRED from memory (not re-checked page by page): `{CHECKOUT_SESSION_ID}` placeholder in `success_url`,
 *    `GET /v1/checkout/sessions/{id}` with `expand[]=payment_intent`, `payment_status` values (`paid` / `unpaid` /
 *    `no_payment_required`), session `status` values (`open` / `complete` / `expired`), event names
 *    `checkout.session.completed|async_payment_succeeded|async_payment_failed|expired`, `GET /v1/balance` as a harmless
 *    key check, `POST /v1/refunds` with `payment_intent` + `amount`, `GET /v1/payment_intents/{id}`.
 *
 * NOT run against a live/sandbox Stripe account.
 *
 * Wiring notes: `config.credentials.secretKey` and `config.credentials.webhookSecret` are read; the webhook handler
 * must pass the RAW request body and lower-case header names (`stripe-signature`).
 */
@Injectable()
export class StripeOwnPaymentProvider implements PaymentProvider {
  readonly providerKey = 'stripe_own' as const;
  // Every result is re-read from the authenticated Retrieve Session call; the webhook is only a signed trigger.
  readonly callbackIsAuthoritative = false;
  private readonly logger = new Logger(StripeOwnPaymentProvider.name);

  private secretKey(config: DecryptedPaymentConfig): string {
    const key = config?.credentials?.secretKey;
    if (!key || typeof key !== 'string') throw new Error('Stripe secret key is required');
    return key;
  }

  private modeLabel(config: DecryptedPaymentConfig): string {
    return config.mode === 'live' ? 'live' : 'test (sandbox)';
  }

  /** Form-encoded request to Stripe. Returns the parsed body and HTTP status; never throws on non-2xx. */
  private async call(
    config: DecryptedPaymentConfig,
    method: 'GET' | 'POST',
    path: string,
    form?: URLSearchParams,
  ): Promise<{ ok: boolean; status: number; body: any }> {
    const res = await fetch(`${STRIPE_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey(config)}`,
        // Set by the Stripe Standard rail: the request runs ON the seller's connected account (direct charge).
        ...(config.credentials?.connectedAccountId ? { 'Stripe-Account': String(config.credentials.connectedAccountId) } : {}),
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: method === 'POST' ? (form ?? new URLSearchParams()).toString() : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let body: any = {};
    try {
      const text = await res.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    return { ok: res.ok, status: res.status, body };
  }

  private errorMessage(body: any): string {
    return String(body?.error?.message || body?.error?.code || 'unknown error');
  }

  async testConnection(config: DecryptedPaymentConfig): Promise<ConnectionTestResult> {
    try {
      const r = await this.call(config, 'GET', '/v1/balance');
      if (r.ok) return { ok: true, message: `Connected to Stripe (${this.modeLabel(config)} mode).` };
      if (r.status === 401 || r.status === 403) {
        return {
          ok: false,
          message: `Stripe rejected this key in ${this.modeLabel(config)} mode (${this.errorMessage(r.body)}). Check the secret key and that it matches the selected mode.`,
        };
      }
      return { ok: false, message: `Stripe answered HTTP ${r.status}: ${this.errorMessage(r.body)}` };
    } catch (e: any) {
      return { ok: false, message: `Could not reach Stripe: ${e?.message || 'network error'}` };
    }
  }

  async initiatePayment(order: PaymentOrderContext, config: DecryptedPaymentConfig): Promise<PaymentSession> {
    const currency = String(order.currency || '').toLowerCase();
    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('line_items[0][quantity]', '1');
    form.set('line_items[0][price_data][currency]', currency);
    form.set('line_items[0][price_data][unit_amount]', String(toStripeAmount(order.amount, order.currency)));
    form.set('line_items[0][price_data][product_data][name]', `Order ${String(order.orderId).slice(-12)}`);
    // The value keeps the literal `{CHECKOUT_SESSION_ID}` placeholder. The form body percent-encodes the braces on
    // the wire (standard form encoding); Stripe decodes the value and then substitutes the session id.
    const sep = order.returnUrl.includes('?') ? '&' : '?';
    form.set('success_url', `${order.returnUrl}${sep}session_id={CHECKOUT_SESSION_ID}`);
    form.set('cancel_url', order.cancelUrl);
    form.set('client_reference_id', String(order.orderId).slice(0, 200));
    if (order.buyerEmail) form.set('customer_email', order.buyerEmail);
    form.set('metadata[checkoutId]', String(order.orderId));
    form.set('metadata[storeId]', String(order.storeId));

    const r = await this.call(config, 'POST', '/v1/checkout/sessions', form);
    if (!r.ok) throw new Error(`Stripe could not start the payment (HTTP ${r.status}): ${this.errorMessage(r.body)}`);
    if (!r.body?.url || !r.body?.id) throw new Error('Stripe did not return a checkout URL');
    return { redirectUrl: r.body.url, sessionId: r.body.id };
  }

  /** Maps a Checkout Session object to our status shape. */
  private mapSession(session: any): PaymentStatus {
    const currency = session?.currency ? String(session.currency) : undefined;
    let status: PaymentStatus['status'] = 'pending';
    if (session?.payment_status === 'paid') status = 'paid';
    else if (session?.status === 'expired') status = 'failed';
    const pi = session?.payment_intent;
    const paymentId = typeof pi === 'string' ? pi : pi?.id;
    return {
      status,
      providerReference: String(session?.id ?? ''),
      ...(paymentId ? { paymentId } : {}),
      ...(currency ? { amount: fromStripeAmount(session?.amount_total, currency), currency: currency.toUpperCase() } : {}),
      raw: session,
    };
  }

  async verifyPayment(sessionId: string, config: DecryptedPaymentConfig): Promise<PaymentStatus> {
    const r = await this.call(config, 'GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent`);
    if (!r.ok) throw new Error(`Stripe could not verify the payment (HTTP ${r.status}): ${this.errorMessage(r.body)}`);
    return this.mapSession(r.body);
  }

  async handleWebhook(rawBody: Buffer, headers: Record<string, string>, config: DecryptedPaymentConfig): Promise<PaymentEvent> {
    const secret = config?.credentials?.webhookSecret;
    if (!secret || typeof secret !== 'string') throw new Error('Stripe webhook signing secret is not configured');
    const header = headers?.['stripe-signature'];
    if (!header) throw new Error('Missing Stripe-Signature header');

    let timestamp = '';
    const signatures: string[] = [];
    for (const part of String(header).split(',')) {
      const idx = part.indexOf('=');
      if (idx < 0) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k === 't') timestamp = v;
      else if (k === 'v1') signatures.push(v); // other schemes (v0) are ignored on purpose
    }
    if (!timestamp || !signatures.length) throw new Error('Malformed Stripe-Signature header');

    const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const match = signatures.some((sig) => {
      const sigBuf = Buffer.from(sig, 'utf8');
      return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
    });
    if (!match) throw new Error('Invalid Stripe webhook signature');

    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > WEBHOOK_TOLERANCE_SECONDS) {
      throw new Error('Stripe webhook timestamp is outside the tolerance window');
    }

    let event: any;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new Error('Stripe webhook body is not valid JSON');
    }
    const session = event?.data?.object ?? {};
    const mapped = this.mapSession(session);

    let type: PaymentEvent['type'] = 'payment_pending';
    switch (event?.type) {
      case 'checkout.session.completed':
        type = session.payment_status === 'paid' ? 'payment_succeeded' : 'payment_pending';
        break;
      case 'checkout.session.async_payment_succeeded':
        type = 'payment_succeeded';
        mapped.status = 'paid';
        break;
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired':
        type = 'payment_failed';
        mapped.status = 'failed';
        break;
      default:
        type = 'payment_pending';
    }
    return { type, externalEventId: String(event?.id ?? ''), sessionId: String(session?.id ?? ''), status: mapped };
  }

  async refund(transactionId: string, amount: number, config: DecryptedPaymentConfig): Promise<RefundResult> {
    try {
      let paymentIntentId = transactionId;
      if (transactionId.startsWith('cs_')) {
        const s = await this.call(config, 'GET', `/v1/checkout/sessions/${encodeURIComponent(transactionId)}`);
        const pi = s.body?.payment_intent;
        paymentIntentId = typeof pi === 'string' ? pi : pi?.id;
        if (!s.ok || !paymentIntentId) {
          this.logger.warn(`Stripe refund: no payment intent for session ${transactionId}: ${this.errorMessage(s.body)}`);
          return { success: false, refundId: '', amount, status: 'failed' };
        }
      }
      const pi = await this.call(config, 'GET', `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`);
      if (!pi.ok || !pi.body?.currency) {
        this.logger.warn(`Stripe refund: cannot read payment ${paymentIntentId} (HTTP ${pi.status}): ${this.errorMessage(pi.body)}`);
        return { success: false, refundId: '', amount, status: 'failed' };
      }
      const form = new URLSearchParams();
      form.set('payment_intent', paymentIntentId);
      form.set('amount', String(toStripeAmount(amount, pi.body.currency)));
      const r = await this.call(config, 'POST', '/v1/refunds', form);
      if (!r.ok) {
        this.logger.warn(`Stripe refund rejected for ${paymentIntentId} (HTTP ${r.status}): ${this.errorMessage(r.body)}`);
        return { success: false, refundId: '', amount, status: 'failed' };
      }
      const st = String(r.body?.status || '');
      const status: RefundResult['status'] = st === 'succeeded' ? 'succeeded' : st === 'failed' || st === 'canceled' ? 'failed' : 'pending';
      return { success: status !== 'failed', refundId: String(r.body?.id ?? ''), amount, status };
    } catch (e: any) {
      this.logger.warn(`Stripe refund failed for ${transactionId}: ${e?.message}`);
      return { success: false, refundId: '', amount, status: 'failed' };
    }
  }

  getPublicConfig(config: Record<string, any>) {
    return { displayName: config?.displayName ?? 'Stripe', currency: config?.currency ?? '', logo: config?.logo };
  }
}
