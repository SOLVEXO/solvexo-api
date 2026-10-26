/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
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
 * Paystack (paystack.com) — hosted checkout with the SELLER'S OWN secret key (Bearer auth). The platform never
 * touches the money. One host serves test and live; the mode is implied by the key prefix (sk_test_ / sk_live_).
 *
 * Docs checked (2026-10-26): paystack.com/docs/api (currency subunit note), paystack.com/docs/payments/accept-payments,
 * github.com/PaystackOSS/openapi (paths + methods of /transaction/initialize, /transaction/verify/{reference}).
 * The paystack.com docs pages answered 403 to our fetcher, so field-level details below are partly INFERRED.
 *
 * VERIFIED (from search results of the official docs / OpenAPI paths): POST /transaction/initialize needs email +
 * amount and returns authorization_url / access_code / reference; GET /transaction/verify/{reference}; amounts are in
 * the currency's subunit and XOF must ALSO be multiplied by 100 ("no subunit for XOF, multiply by 100 regardless").
 * INFERRED (from memory / third-party SDK docs): reference may contain only alphanumerics, '-', '.', '='; verify
 * statuses success/failed/abandoned/ongoing/pending/processing/queued/reversed; webhook header `x-paystack-signature`
 * = HMAC-SHA512 of the raw body keyed with the secret key; event `charge.success` (failed card payments are
 * reported through the verify call, no webhook event is mapped to failed here); POST /refund {transaction, amount}
 * with refund statuses pending/processing/processed/failed; GET /balance as the connection probe; every supported
 * currency (NGN, GHS, ZAR, KES, XOF, EGP, RWF, USD) uses a x100 subunit.
 *
 * NOT run against a live/sandbox Paystack account.
 */

const API_BASE = 'https://api.paystack.co';

/** Major units -> Paystack subunit integer. Every Paystack currency we list (incl. XOF, RWF) is x100. */
export function toPaystackSubunit(amount: number): number {
  return Math.round(Number(amount) * 100);
}

/** Paystack subunit integer -> major units. */
export function fromPaystackSubunit(subunit: number): number {
  return Math.round(Number(subunit)) / 100;
}

@Injectable()
export class PaystackPaymentProvider implements PaymentProvider {
  readonly providerKey = 'paystack' as const;
  /** Result is always re-read from Paystack's verify endpoint, the callback is not proof. */
  readonly callbackIsAuthoritative = false;
  private readonly logger = new Logger(PaystackPaymentProvider.name);

  private headers(config: DecryptedPaymentConfig): Record<string, string> {
    return {
      Authorization: `Bearer ${config.credentials?.secretKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private async call(method: 'GET' | 'POST', path: string, config: DecryptedPaymentConfig, body?: unknown): Promise<{ ok: boolean; status: number; data: any; text: string }> {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: this.headers(config),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    let text = '';
    let data: any = null;
    try {
      text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data, text };
  }

  async testConnection(config: DecryptedPaymentConfig): Promise<ConnectionTestResult> {
    if (!config.credentials?.secretKey) return { ok: false, message: 'Paystack secret key is missing' };
    try {
      const r = await this.call('GET', '/bank?perPage=1', config);
      if (r.status === 401 || r.status === 403) {
        return { ok: false, message: `Paystack rejected this secret key (HTTP ${r.status}) — check it is the secret key (sk_...) from Settings > API Keys & Webhooks` };
      }
      if (!r.ok) return { ok: false, message: `Paystack returned HTTP ${r.status}: ${r.text.slice(0, 200)}` };
      const key = String(config.credentials.secretKey);
      const mode = key.startsWith('sk_test_') ? 'test' : key.startsWith('sk_live_') ? 'live' : 'unknown-mode';
      return { ok: true, message: `Paystack ${mode} secret key accepted` };
    } catch (err: any) {
      return { ok: false, message: `Could not reach Paystack: ${err?.message ?? 'network error'}` };
    }
  }

  async initiatePayment(order: PaymentOrderContext, config: DecryptedPaymentConfig): Promise<PaymentSession> {
    if (!order.buyerEmail) throw new Error('Paystack needs the buyer email address');
    // Allowed reference characters: alphanumeric, '-', '.', '='. A random suffix keeps every attempt unique.
    const safeId = String(order.orderId).replace(/[^A-Za-z0-9\-.=]/g, '');
    const reference = `${safeId}-${randomBytes(6).toString('hex')}`;
    const r = await this.call('POST', '/transaction/initialize', config, {
      email: order.buyerEmail,
      amount: toPaystackSubunit(order.amount),
      currency: order.currency,
      reference,
      callback_url: order.returnUrl,
      metadata: { checkoutId: order.orderId, storeId: order.storeId },
    });
    if (!r.ok || r.data?.status === false) {
      throw new Error(`Paystack initialize failed (${r.status}): ${r.data?.message ?? r.text.slice(0, 200)}`);
    }
    const url: string | undefined = r.data?.data?.authorization_url;
    if (!url) throw new Error('Paystack initialize response did not include authorization_url');
    return { redirectUrl: url, sessionId: String(r.data?.data?.reference ?? reference) };
  }

  async verifyPayment(reference: string, config: DecryptedPaymentConfig): Promise<PaymentStatus> {
    const r = await this.call('GET', `/transaction/verify/${encodeURIComponent(reference)}`, config);
    if (!r.ok) {
      const msg = String(r.data?.message ?? r.text);
      // The buyer may not have opened the hosted page yet: Paystack does not know the reference.
      if ((r.status === 404 || r.status === 400) && /reference not found/i.test(msg)) {
        return { status: 'pending', providerReference: reference };
      }
      throw new Error(`Paystack verify failed (${r.status}): ${msg.slice(0, 200)}`);
    }
    const d = r.data?.data ?? {};
    const status = this.mapStatus(d.status);
    return {
      status,
      providerReference: reference,
      paymentId: d.id !== undefined && d.id !== null ? String(d.id) : undefined,
      amount: status === 'paid' && d.amount !== undefined ? fromPaystackSubunit(d.amount) : undefined,
      currency: d.currency,
      raw: d,
    };
  }

  private mapStatus(s: string | undefined): PaymentStatus['status'] {
    switch (s) {
      case 'success':
        return 'paid';
      case 'failed':
      case 'abandoned':
      case 'reversed':
        return 'failed';
      default:
        // ongoing / pending / processing / queued / unknown
        return 'pending';
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- HMAC verification is synchronous; async to satisfy the shared PaymentProvider interface
  async handleWebhook(rawBody: Buffer, headers: Record<string, string>, config: DecryptedPaymentConfig): Promise<PaymentEvent> {
    const signature = headers['x-paystack-signature'] ?? headers['X-Paystack-Signature'];
    if (!signature) throw new Error('Missing x-paystack-signature header');
    const expected = createHmac('sha512', String(config.credentials?.secretKey ?? '')).update(rawBody).digest('hex');
    const a = Buffer.from(String(signature).toLowerCase(), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Paystack webhook signature mismatch');

    const payload = JSON.parse(rawBody.toString('utf8'));
    const event: string = String(payload?.event ?? '');
    const d = payload?.data ?? {};
    const reference: string = String(d.reference ?? '');
    const externalEventId = `${event}:${d.id ?? d.reference}`;
    const paymentId = d.id !== undefined && d.id !== null ? String(d.id) : undefined;

    if (event === 'charge.success') {
      return {
        type: 'payment_succeeded',
        externalEventId,
        sessionId: reference,
        status: { status: 'paid', providerReference: reference, paymentId, amount: fromPaystackSubunit(d.amount), currency: d.currency, raw: payload },
      };
    }
    if (event === 'charge.failed') {
      return {
        type: 'payment_failed',
        externalEventId,
        sessionId: reference,
        status: { status: 'failed', providerReference: reference, paymentId, currency: d.currency, raw: payload },
      };
    }
    return {
      type: 'payment_pending',
      externalEventId,
      sessionId: reference,
      status: { status: 'pending', providerReference: reference, raw: payload },
    };
  }

  async refund(paymentId: string, amount: number, config: DecryptedPaymentConfig): Promise<RefundResult> {
    try {
      // All Paystack currencies we list are x100, so the currency is not needed for the conversion.
      const r = await this.call('POST', '/refund', config, { transaction: paymentId, amount: toPaystackSubunit(amount) });
      if (!r.ok || r.data?.status === false) {
        this.logger.warn(`Paystack refund failed for ${paymentId} (${r.status}): ${String(r.data?.message ?? r.text).slice(0, 200)}`);
        return { success: false, refundId: '', amount, status: 'failed' };
      }
      const d = r.data?.data ?? {};
      const status: RefundResult['status'] = d.status === 'processed' ? 'succeeded' : d.status === 'failed' ? 'failed' : 'pending';
      return {
        success: status !== 'failed',
        refundId: String(d.id ?? d.reference ?? ''),
        amount,
        status,
      };
    } catch (err: any) {
      this.logger.warn(`Paystack refund error for ${paymentId}: ${err?.message ?? err}`);
      return { success: false, refundId: '', amount, status: 'failed' };
    }
  }

  getPublicConfig(config: Record<string, any>) {
    return {
      displayName: config.displayName ?? 'Paystack',
      currency: config.currency ?? '',
      logo: config.logo,
    };
  }
}
