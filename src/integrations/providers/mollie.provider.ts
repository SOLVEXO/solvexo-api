/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { API_PUBLIC_ORIGIN } from '../../common/api-origin';
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
 * Mollie hosted checkout with the SELLER'S OWN API key (Bearer) against https://api.mollie.com/v2. The key prefix
 * (`test_` / `live_`) decides test or live mode, the host is the same. The platform never touches the money.
 *
 * Flow: POST /payments -> redirect buyer to `_links.checkout.href`. Mollie POSTs only `id=tr_...` (form body, no
 * signature, no status) to the per-payment `webhookUrl`; the truth is always fetched with GET /payments/{id} using
 * the seller's key, so a forged webhook can never mark anything paid (Mollie's own recommended model).
 *
 * Docs checked (2026-10-26):
 *  - https://docs.mollie.com/reference/create-payment  (VERIFIED: amount {currency,value string}, description <=255,
 *    redirectUrl, cancelUrl optional (falls back to redirectUrl), webhookUrl, metadata ~1 kB, _links.checkout,
 *    statuses open/pending/authorized/paid/canceled/expired/failed)
 *  - https://docs.mollie.com/reference/webhooks  (VERIFIED: form `id`, no signature, answer 200, retries on non-200)
 *  - https://docs.mollie.com/reference/create-refund  (VERIFIED: POST /payments/{id}/refunds {amount}, statuses
 *    queued/pending/processing/refunded/failed/canceled)
 *  - https://docs.mollie.com/reference/list-methods  (VERIFIED: GET /methods works with a plain API key, no params)
 *  - https://docs.mollie.com/docs/multicurrency  (VERIFIED: only JPY and ISK have 0 decimals, all others 2)
 * INFERRED (not stated in the docs read): `error` shape `{status,title,detail}` on failures; the get-payment
 * response fields `amountRefunded`/`amountRemaining` (from memory).
 *
 * NOT run against a live/sandbox Mollie account.
 */

const MOLLIE_API = 'https://api.mollie.com/v2';
const TIMEOUT_MS = 20_000;
const PAYMENT_ID = /^tr_[A-Za-z0-9]+$/;
/** Currencies Mollie takes with 0 decimals (everything else has 2). */
const ZERO_DECIMAL = new Set(['JPY', 'ISK']);

/** Mollie amount value: major units as a string with the currency's decimals ("10.00", JPY "10"). */
export function formatMollieAmount(amount: number, currency: string): string {
  const cur = String(currency).toUpperCase();
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid payment amount');
  return ZERO_DECIMAL.has(cur) ? String(Math.round(amount)) : (Math.round(amount * 100) / 100).toFixed(2);
}

@Injectable()
export class MolliePaymentProvider implements PaymentProvider {
  readonly providerKey = 'mollie' as const;
  // No signature on the webhook: every result is re-read from the authenticated API.
  readonly callbackIsAuthoritative = false;
  private readonly logger = new Logger(MolliePaymentProvider.name);

  private apiKey(config: DecryptedPaymentConfig): string {
    const key = String(config.credentials?.apiKey ?? '').trim();
    if (!key) throw new Error('Mollie API key is required');
    return key;
  }

  private async call(config: DecryptedPaymentConfig, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Record<string, any>> {
    const res = await fetch(`${MOLLIE_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey(config)}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let data: Record<string, any> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const detail = data?.detail || data?.title || text.slice(0, 200);
      const err = new Error(`Mollie ${method} ${path} failed (HTTP ${res.status}): ${detail}`);
      (err as any).status = res.status;
      throw err;
    }
    return data;
  }

  private static toStatus(p: Record<string, any>): PaymentStatus {
    const s = String(p.status ?? '');
    const status: PaymentStatus['status'] =
      s === 'paid' ? 'paid' : s === 'failed' || s === 'canceled' || s === 'expired' ? 'failed' : 'pending';
    const out: PaymentStatus = { status, providerReference: String(p.id), raw: { status: s, mode: p.mode } };
    if (status === 'paid') {
      out.paymentId = String(p.id);
      out.amount = Number(p.amount?.value);
      out.currency = p.amount?.currency;
    }
    return out;
  }

  async testConnection(config: DecryptedPaymentConfig): Promise<ConnectionTestResult> {
    try {
      await this.call(config, 'GET', '/methods');
      const key = this.apiKey(config);
      return { ok: true, message: `Connected to Mollie (${key.startsWith('test_') ? 'test' : 'live'} key accepted).` };
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 403) {
        return { ok: false, message: 'Mollie rejected this API key. Check that it is correct and that it is a test_ key for sandbox or a live_ key for live.' };
      }
      return { ok: false, message: e?.message ?? 'Could not reach Mollie' };
    }
  }

  async initiatePayment(order: PaymentOrderContext, config: DecryptedPaymentConfig): Promise<PaymentSession> {
    if (!config.webhookToken) throw new Error('Mollie webhook token is missing');
    const body = {
      amount: { currency: order.currency.toUpperCase(), value: formatMollieAmount(order.amount, order.currency) },
      description: `Order ${order.orderId}`.slice(0, 255),
      redirectUrl: order.returnUrl,
      cancelUrl: order.cancelUrl,
      webhookUrl: `${API_PUBLIC_ORIGIN}/webhooks/payments/mollie/${config.webhookToken}`,
      metadata: { checkoutId: order.orderId, storeId: order.storeId },
    };
    const p = await this.call(config, 'POST', '/payments', body);
    const href = p?._links?.checkout?.href;
    if (!p?.id || !href) throw new Error('Mollie did not return a checkout link');
    return { redirectUrl: String(href), sessionId: String(p.id) };
  }

  async verifyPayment(paymentId: string, config: DecryptedPaymentConfig): Promise<PaymentStatus> {
    if (!PAYMENT_ID.test(paymentId)) throw new Error('Invalid Mollie payment id');
    return MolliePaymentProvider.toStatus(await this.call(config, 'GET', `/payments/${paymentId}`));
  }

  async handleWebhook(rawBody: Buffer, _headers: Record<string, string>, config: DecryptedPaymentConfig): Promise<PaymentEvent> {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
    let id = '';
    try {
      const trimmed = text.trim();
      if (trimmed.startsWith('{')) id = String(JSON.parse(trimmed)?.id ?? '');
      else id = new URLSearchParams(trimmed).get('id') ?? '';
    } catch {
      id = '';
    }
    if (!PAYMENT_ID.test(id)) throw new Error('Mollie webhook has no valid payment id');
    // No signature: authenticity = the payment exists under THIS seller's key.
    const payment = await this.call(config, 'GET', `/payments/${id}`);
    const status = MolliePaymentProvider.toStatus(payment);
    const type = status.status === 'paid' ? 'payment_succeeded' : status.status === 'failed' ? 'payment_failed' : 'payment_pending';
    return { type, externalEventId: `${id}:${String(payment.status)}`, sessionId: id, status };
  }

  async refund(paymentId: string, amount: number, config: DecryptedPaymentConfig): Promise<RefundResult> {
    try {
      if (!PAYMENT_ID.test(paymentId)) throw new Error('Invalid Mollie payment id');
      const payment = await this.call(config, 'GET', `/payments/${paymentId}`);
      const currency = String(payment.amount?.currency ?? '');
      if (!currency) throw new Error('Mollie payment has no currency');
      const r = await this.call(config, 'POST', `/payments/${paymentId}/refunds`, {
        amount: { currency, value: formatMollieAmount(amount, currency) },
      });
      const s = String(r.status ?? '');
      const status: RefundResult['status'] = s === 'refunded' ? 'succeeded' : s === 'failed' || s === 'canceled' ? 'failed' : 'pending';
      return { success: status !== 'failed', refundId: String(r.id ?? ''), amount, status };
    } catch (e: any) {
      this.logger.warn(`Mollie refund for ${paymentId} failed: ${e?.message ?? e}`);
      return { success: false, refundId: '', amount, status: 'failed' };
    }
  }

  getPublicConfig(config: Record<string, any>) {
    return { displayName: config.displayName ?? 'Mollie', currency: config.currency ?? '', logo: config.logo };
  }
}
