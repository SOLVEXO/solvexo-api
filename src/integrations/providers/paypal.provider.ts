/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
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
 * PayPal Checkout (Orders API v2) with the SELLER'S OWN REST app credentials — the platform never touches the money.
 *
 * Flow: `initiatePayment` creates an order (intent CAPTURE) and returns the buyer-approval link; the buyer returns to
 * the storefront, and `verifyPayment` reads the order and — when it is APPROVED but not yet captured — captures it
 * (idempotent). The `PAYMENT.CAPTURE.COMPLETED` webhook is the second path to the same result.
 *
 * Docs checked (2026-10-26):
 *  - https://developer.paypal.com/docs/api/orders/v2/ and its OpenAPI schema https://developer.paypal.com/api/orders/v2/schema.json
 *  - https://developer.paypal.com/docs/api/payments/v2/ (captures show / refund)
 *  - https://developer.paypal.com/docs/api/webhooks/v1/ and https://developer.paypal.com/api/webhooks/v1/schema.json
 *
 * VERIFIED from the OpenAPI schemas: order status enum (CREATED, SAVED, APPROVED, VOIDED, COMPLETED,
 * PAYER_ACTION_REQUIRED); capture status enum (COMPLETED, DECLINED, PARTIALLY_REFUNDED, PENDING, REFUNDED, FAILED);
 * `payment_source.paypal.experience_context` fields (return_url, cancel_url, user_action CONTINUE|PAY_NOW,
 * landing_page LOGIN|GUEST_CHECKOUT|NO_PREFERENCE|BILLING); the `payer-action` HATEOAS link; verify-webhook-signature
 * request fields (auth_algo, cert_url, transmission_id, transmission_sig, transmission_time, webhook_id,
 * webhook_event) and `verification_status` SUCCESS|FAILURE; `PayPal-Request-Id` idempotency header; refund with an
 * `amount {value, currency_code}` body.
 * INFERRED / from memory (not in the schemas fetched): hosts api-m.paypal.com / api-m.sandbox.paypal.com and the
 * `/v1/oauth2/token` client-credentials call; the `ORDER_ALREADY_CAPTURED` 422 error name; the capture webhook's
 * `resource.supplementary_data.related_ids.order_id` (fallback: the `up` link of the capture, which ends with the
 * order id); JPY/HUF/TWD being the zero-decimal PayPal currencies.
 *
 * NOT run against a live/sandbox PayPal account.
 */

/** PayPal currencies that take NO decimals (all others use 2). */
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'HUF', 'TWD']);

/** Formats a major-unit amount as the string PayPal expects for `currency` (JPY/HUF/TWD: 0 decimals, others: 2). */
export function formatPayPalAmount(amount: number, currency: string): string {
  const decimals = ZERO_DECIMAL_CURRENCIES.has(String(currency).toUpperCase()) ? 0 : 2;
  return Number(amount).toFixed(decimals);
}

interface ApiResult {
  ok: boolean;
  status: number;
  data: any;
}

const TIMEOUT_MS = 20_000;
const TOKEN_CACHE_MAX = 50;

@Injectable()
export class PayPalPaymentProvider implements PaymentProvider {
  readonly providerKey = 'paypal' as const;
  // The webhook is signature-verified, but the order/capture is always re-read from PayPal before finalizing.
  readonly callbackIsAuthoritative = false;
  private readonly logger = new Logger(PayPalPaymentProvider.name);
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  private apiBase(mode: 'sandbox' | 'live'): string {
    return mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  }

  private creds(config: DecryptedPaymentConfig) {
    const { clientId, clientSecret } = config.credentials ?? {};
    if (!clientId || !clientSecret) throw new Error('PayPal client ID and client secret are required');
    return { clientId: String(clientId), clientSecret: String(clientSecret) };
  }

  private async accessToken(config: DecryptedPaymentConfig): Promise<string> {
    const { clientId, clientSecret } = this.creds(config);
    const key = `${config.mode}:${clientId}`;
    const hit = this.tokens.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.token;

    const res = await fetch(`${this.apiBase(config.mode)}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) {
      throw new Error(`PayPal rejected these credentials in ${config.mode} mode (HTTP 401) — check the client ID/secret belong to ${config.mode}`);
    }
    if (!res.ok) throw new Error(`PayPal token request failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    const data: any = await res.json();
    if (!data?.access_token) throw new Error('PayPal token response had no access_token');
    if (this.tokens.size >= TOKEN_CACHE_MAX) this.tokens.delete(this.tokens.keys().next().value as string);
    this.tokens.set(key, { token: data.access_token, expiresAt: Date.now() + Math.max(0, (Number(data.expires_in) || 300) - 60) * 1000 });
    return data.access_token;
  }

  private async api(config: DecryptedPaymentConfig, method: 'GET' | 'POST', path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<ApiResult> {
    const token = await this.accessToken(config);
    const res = await fetch(`${this.apiBase(config.mode)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
    return { ok: res.ok, status: res.status, data };
  }

  private errorSummary(r: ApiResult): string {
    const d = r.data ?? {};
    const issue = d.details?.[0]?.issue;
    return `HTTP ${r.status}${d.name ? ` ${d.name}` : ''}${issue ? ` (${issue})` : ''}${d.message ? `: ${String(d.message).slice(0, 200)}` : ''}`;
  }

  private hasIssue(r: ApiResult, name: string): boolean {
    const d = r.data ?? {};
    return d.name === name || (Array.isArray(d.details) && d.details.some((x: any) => x?.issue === name));
  }

  async testConnection(config: DecryptedPaymentConfig): Promise<ConnectionTestResult> {
    try {
      await this.accessToken(config);
      return { ok: true, message: `Connected to PayPal (${config.mode})` };
    } catch (err: any) {
      return { ok: false, message: err?.message ?? 'Could not reach PayPal' };
    }
  }

  async initiatePayment(order: PaymentOrderContext, config: DecryptedPaymentConfig): Promise<PaymentSession> {
    const currency = String(order.currency).toUpperCase();
    const r = await this.api(
      config,
      'POST',
      '/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: order.orderId,
            custom_id: order.orderId,
            amount: { currency_code: currency, value: formatPayPalAmount(order.amount, currency) },
          },
        ],
        payment_source: {
          paypal: {
            ...(order.buyerEmail ? { email_address: order.buyerEmail } : {}),
            experience_context: {
              return_url: order.returnUrl,
              cancel_url: order.cancelUrl,
              user_action: 'PAY_NOW',
              landing_page: 'LOGIN',
            },
          },
        },
      },
      { 'PayPal-Request-Id': `create-${randomUUID()}`, Prefer: 'return=representation' },
    );
    if (!r.ok) throw new Error(`PayPal could not create the order: ${this.errorSummary(r)}`);
    const links: any[] = r.data?.links ?? [];
    const link = links.find((l) => l?.rel === 'payer-action') ?? links.find((l) => l?.rel === 'approve');
    if (!r.data?.id || !link?.href) throw new Error('PayPal order response had no approval link');
    return { redirectUrl: link.href, sessionId: String(r.data.id) };
  }

  /** Maps a PayPal order (already captured or not) to our status. */
  private mapOrder(order: any, sessionId: string): PaymentStatus {
    const base = { providerReference: sessionId, raw: order };
    switch (order?.status) {
      case 'COMPLETED': {
        const capture = order?.purchase_units?.[0]?.payments?.captures?.[0];
        if (!capture) return { status: 'pending', ...base };
        const amount = capture.amount ? Number(capture.amount.value) : undefined;
        const currency = capture.amount?.currency_code;
        const done = { paymentId: capture.id, amount, currency, ...base };
        if (capture.status === 'COMPLETED' || capture.status === 'PARTIALLY_REFUNDED') return { status: 'paid', ...done };
        if (capture.status === 'REFUNDED') return { status: 'refunded', ...done };
        if (capture.status === 'DECLINED' || capture.status === 'FAILED') return { status: 'failed', ...base };
        return { status: 'pending', ...base };
      }
      case 'VOIDED':
        return { status: 'failed', ...base };
      default: // CREATED, SAVED, APPROVED (not yet captured), PAYER_ACTION_REQUIRED
        return { status: 'pending', ...base };
    }
  }

  async verifyPayment(sessionId: string, config: DecryptedPaymentConfig): Promise<PaymentStatus> {
    const id = encodeURIComponent(sessionId);
    let r = await this.api(config, 'GET', `/v2/checkout/orders/${id}`);
    if (!r.ok) throw new Error(`PayPal order lookup failed: ${this.errorSummary(r)}`);

    if (r.data?.status === 'APPROVED') {
      // The buyer approved but nothing is captured yet — capture now (same request id = safe to repeat).
      const cap = await this.api(config, 'POST', `/v2/checkout/orders/${id}/capture`, {}, { 'PayPal-Request-Id': `capture-${sessionId}`, Prefer: 'return=representation' });
      if (cap.ok) {
        r = cap;
      } else if (cap.status === 422 && this.hasIssue(cap, 'ORDER_ALREADY_CAPTURED')) {
        r = await this.api(config, 'GET', `/v2/checkout/orders/${id}`);
        if (!r.ok) throw new Error(`PayPal order lookup failed: ${this.errorSummary(r)}`);
      } else if (cap.status === 422 && this.hasIssue(cap, 'INSTRUMENT_DECLINED')) {
        // The buyer can pick another funding source on PayPal and approve again.
        return { status: 'pending', providerReference: sessionId, raw: cap.data };
      } else {
        throw new Error(`PayPal capture failed: ${this.errorSummary(cap)}`);
      }
    }
    return this.mapOrder(r.data, sessionId);
  }

  async handleWebhook(rawBody: Buffer, headers: Record<string, string>, config: DecryptedPaymentConfig): Promise<PaymentEvent> {
    const webhookId = config.credentials?.webhookSecret;
    if (!webhookId) throw new Error('PayPal Webhook ID is not configured');
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers ?? {})) h[k.toLowerCase()] = String(v);
    const needed = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
    if (needed.some((k) => !h[k])) throw new Error('Missing PayPal webhook signature headers');

    let event: any;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new Error('PayPal webhook body is not valid JSON');
    }

    const check = await this.api(config, 'POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: h['paypal-auth-algo'],
      cert_url: h['paypal-cert-url'],
      transmission_id: h['paypal-transmission-id'],
      transmission_sig: h['paypal-transmission-sig'],
      transmission_time: h['paypal-transmission-time'],
      webhook_id: String(webhookId),
      webhook_event: event,
    });
    if (!check.ok || check.data?.verification_status !== 'SUCCESS') throw new Error('Invalid PayPal webhook signature');

    const resource = event?.resource ?? {};
    const externalEventId = String(event?.id ?? '');
    const type = event?.event_type;

    if (type === 'PAYMENT.CAPTURE.COMPLETED' || type === 'PAYMENT.CAPTURE.DENIED' || type === 'PAYMENT.CAPTURE.DECLINED') {
      const sessionId = this.orderIdFromCapture(resource);
      if (type === 'PAYMENT.CAPTURE.COMPLETED') {
        return {
          type: 'payment_succeeded',
          externalEventId,
          sessionId,
          status: {
            status: 'paid',
            providerReference: sessionId,
            paymentId: resource.id,
            amount: resource.amount ? Number(resource.amount.value) : undefined,
            currency: resource.amount?.currency_code,
            raw: event,
          },
        };
      }
      return { type: 'payment_failed', externalEventId, sessionId, status: { status: 'failed', providerReference: sessionId, paymentId: resource.id, raw: event } };
    }

    // CHECKOUT.ORDER.APPROVED (the return page / verifyPayment captures it) and anything else: acknowledge only.
    const sessionId = type === 'CHECKOUT.ORDER.APPROVED' ? String(resource.id ?? '') : this.orderIdFromCapture(resource);
    return { type: 'payment_pending', externalEventId, sessionId, status: { status: 'pending', providerReference: sessionId, raw: event } };
  }

  /** PayPal order id of a capture resource: related_ids.order_id, else the capture's `up` link (…/v2/checkout/orders/<id>). */
  private orderIdFromCapture(resource: any): string {
    const direct = resource?.supplementary_data?.related_ids?.order_id;
    if (direct) return String(direct);
    const up = (resource?.links ?? []).find((l: any) => l?.rel === 'up')?.href as string | undefined;
    const m = up?.match(/\/v2\/checkout\/orders\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  async refund(paymentId: string, amount: number, config: DecryptedPaymentConfig): Promise<RefundResult> {
    const failed: RefundResult = { success: false, refundId: '', amount, status: 'failed' };
    try {
      const id = encodeURIComponent(paymentId);
      const cap = await this.api(config, 'GET', `/v2/payments/captures/${id}`);
      const currency = cap.data?.amount?.currency_code;
      if (!cap.ok || !currency) {
        this.logger.warn(`PayPal refund: could not read capture ${paymentId}: ${this.errorSummary(cap)}`);
        return failed;
      }
      const value = formatPayPalAmount(amount, currency);
      const r = await this.api(config, 'POST', `/v2/payments/captures/${id}/refund`, { amount: { value, currency_code: currency } }, { 'PayPal-Request-Id': `refund-${paymentId}-${value}`, Prefer: 'return=representation' });
      if (!r.ok) {
        this.logger.warn(`PayPal refund of capture ${paymentId} rejected: ${this.errorSummary(r)}`);
        return failed;
      }
      const status = r.data?.status === 'COMPLETED' ? 'succeeded' : r.data?.status === 'PENDING' ? 'pending' : 'failed';
      return { success: status !== 'failed', refundId: String(r.data?.id ?? ''), amount, status };
    } catch (err: any) {
      this.logger.warn(`PayPal refund of capture ${paymentId} failed: ${err?.message}`);
      return failed;
    }
  }

  getPublicConfig(config: Record<string, any>) {
    return { displayName: config?.displayName ?? 'PayPal', currency: config?.currency ?? '', logo: config?.logo };
  }
}
