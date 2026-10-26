/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'crypto';
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
 * Flutterwave "Standard" (hosted payment link) with the SELLER'S OWN secret key — the platform never touches the money.
 *
 * API VERSION: Flutterwave v3 (`https://api.flutterwave.com/v3`, Bearer secret key; test vs live follows the key,
 * test keys look like `FLWSECK_TEST-...`). Flutterwave also has a v4 API (OAuth client id/secret, customer ->
 * payment-method -> charge flow). No official deprecation of v3 was found and v4 has no hosted-link equivalent yet
 * (per a third-party note, not official), so this stays on v3 — that is what the catalog's single `secretKey`
 * field is for. If v3 is ever retired this class must be rewritten for v4. Amounts are MAJOR units (not minor).
 *
 * Flow: `initiatePayment` POST /payments -> hosted `data.link`; the buyer returns to `returnUrl` (UNTRUSTED query
 * params) and the result is read from `verifyPayment` (GET /transactions/verify_by_reference) and from the webhook
 * (`verif-hash` header = the "Secret hash" the seller typed into the dashboard, saved as `credentials.webhookSecret`).
 * Amount/currency/tx_ref are compared downstream with what we charged — this class only returns gateway values.
 *
 * DOCS CHECKED (2026-10-26):
 *  - https://developer.flutterwave.com/v3.0/docs/flutterwave-standard-1 (search summary: POST /v3/payments, tx_ref, redirect_url, customizations, `data.link`) — verified
 *  - https://developer.flutterwave.com/v3.0.0/docs/webhooks (verif-hash header, event `charge.completed`, data.id/status/tx_ref/amount/currency) — verified
 *  - https://developer.flutterwave.com/v3.0.0/reference/verify-transaction-with-tx_ref (GET /transactions/verify_by_reference?tx_ref=, data.status 'successful') — verified
 *  - https://developer.flutterwave.com/v3.0.0/docs/refunds (POST /transactions/{id}/refund {amount}; refund status list) — verified
 * INFERRED / UNSURE: the other `data.status` values (we treat failed/cancelled as failed, the rest as pending); the
 * "not found" reply of verify_by_reference is undocumented (we treat HTTP 404 and a non-success body as pending);
 * GET /balances as the harmless key check (not on the pages above). A newer `flutterwave-signature` HMAC header is NOT
 * documented on the v3 webhook page, so it is NOT supported. Refund status `completed` is documented as "initiated,
 * pending disbursement" — we still report it as succeeded (the refund was accepted and cannot be cancelled by us).
 *
 * NOT run against a live/sandbox Flutterwave account.
 */
@Injectable()
export class FlutterwavePaymentProvider implements PaymentProvider {
  readonly providerKey = 'flutterwave' as const;
  // The webhook only carries the secret hash; the result is always re-asked through the verify API.
  readonly callbackIsAuthoritative = false;
  private readonly logger = new Logger(FlutterwavePaymentProvider.name);

  private static readonly BASE = 'https://api.flutterwave.com/v3';

  private secretKey(config: DecryptedPaymentConfig): string {
    const key = String(config.credentials?.secretKey ?? '').trim();
    if (!key) throw new Error('Flutterwave secret key is required');
    return key;
  }

  private async call(
    config: DecryptedPaymentConfig,
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; ok: boolean; json: Record<string, any> | null; text: string }> {
    const res = await fetch(`${FlutterwavePaymentProvider.BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey(config)}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: Record<string, any> | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, text };
  }

  async testConnection(config: DecryptedPaymentConfig): Promise<ConnectionTestResult> {
    try {
      const r = await this.call(config, 'GET', '/balances');
      if (r.status === 401 || r.status === 403) {
        return { ok: false, message: 'Flutterwave rejected this secret key. Copy it again from Dashboard -> Settings -> API Keys.' };
      }
      if (!r.ok) return { ok: false, message: `Flutterwave answered HTTP ${r.status}: ${(r.json?.message ?? r.text).toString().slice(0, 120)}` };
      return { ok: true, message: 'Connected to Flutterwave — the secret key works.' };
    } catch (e: any) {
      return { ok: false, message: `Could not reach Flutterwave: ${e?.message ?? e}` };
    }
  }

  async initiatePayment(order: PaymentOrderContext, config: DecryptedPaymentConfig): Promise<PaymentSession> {
    if (!order.buyerEmail) throw new Error('Flutterwave needs the buyer email address');
    if (!(order.amount > 0)) throw new Error('Nothing to pay');
    const txRef = `SX-${String(order.orderId).slice(-12)}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
    const r = await this.call(config, 'POST', '/payments', {
      tx_ref: txRef,
      amount: Math.round(order.amount * 100) / 100,
      currency: order.currency.toUpperCase(),
      redirect_url: order.returnUrl,
      customer: {
        email: order.buyerEmail,
        phonenumber: order.buyerPhone || undefined,
        name: order.buyerName || undefined,
      },
      customizations: { title: 'Order payment' },
      meta: { checkoutId: order.orderId, storeId: order.storeId },
    });
    if (!r.ok) {
      throw new Error(`Flutterwave payment could not be started (HTTP ${r.status}): ${(r.json?.message ?? r.text).toString().slice(0, 200)}`);
    }
    const link = r.json?.data?.link;
    if (!link || typeof link !== 'string') throw new Error('Flutterwave did not return a payment link');
    return { redirectUrl: link, sessionId: txRef };
  }

  async verifyPayment(txRef: string, config: DecryptedPaymentConfig): Promise<PaymentStatus> {
    const r = await this.call(config, 'GET', `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);
    if (r.status === 401 || r.status === 403) throw new Error(`Flutterwave rejected the secret key (HTTP ${r.status})`);
    const pending: PaymentStatus = { status: 'pending', providerReference: txRef, raw: r.json ?? undefined };
    // Unknown reference ("No transaction was found for this id") = the buyer has not paid yet.
    if (r.status === 404 || r.status === 400) return pending;
    if (!r.ok) throw new Error(`Flutterwave verify failed (HTTP ${r.status}): ${r.text.slice(0, 200)}`);
    const data = r.json?.data;
    if (!data || typeof data !== 'object') return pending;
    const st = String(data.status ?? '').toLowerCase();
    if (st === 'successful') {
      return {
        status: 'paid',
        providerReference: txRef,
        paymentId: data.id !== undefined ? String(data.id) : undefined,
        amount: Number(data.amount),
        currency: data.currency ? String(data.currency).toUpperCase() : undefined,
        raw: r.json ?? undefined,
      };
    }
    if (st === 'failed' || st === 'cancelled') return { ...pending, status: 'failed' };
    return pending;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- verification is synchronous
  async handleWebhook(rawBody: Buffer, headers: Record<string, string>, config: DecryptedPaymentConfig): Promise<PaymentEvent> {
    const secret = String(config.credentials?.webhookSecret ?? '');
    if (!secret) throw new Error('Flutterwave webhook secret hash is not configured');
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers ?? {})) lower[k.toLowerCase()] = String(v);
    const got = lower['verif-hash'];
    if (!got) throw new Error('Missing Flutterwave verif-hash header');
    const a = Buffer.from(got, 'utf8');
    const b = Buffer.from(secret, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Invalid Flutterwave webhook secret hash');

    let body: Record<string, any>;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new Error('Flutterwave webhook body is not valid JSON');
    }
    const event = String(body.event ?? '');
    const data = body.data ?? {};
    const sessionId = String(data.tx_ref ?? '');
    const dataStatus = String(data.status ?? '').toLowerCase();
    let type: PaymentEvent['type'] = 'payment_pending';
    if (event === 'charge.completed') {
      if (dataStatus === 'successful') type = 'payment_succeeded';
      else if (dataStatus === 'failed') type = 'payment_failed';
    }
    const status: PaymentStatus['status'] = type === 'payment_succeeded' ? 'paid' : type === 'payment_failed' ? 'failed' : 'pending';
    return {
      type,
      externalEventId: `${event}:${data.id ?? ''}:${data.status ?? ''}`,
      sessionId,
      status: {
        status,
        providerReference: sessionId,
        paymentId: data.id !== undefined ? String(data.id) : undefined,
        amount: data.amount !== undefined ? Number(data.amount) : undefined,
        currency: data.currency ? String(data.currency).toUpperCase() : undefined,
      },
    };
  }

  async refund(paymentId: string, amount: number, config: DecryptedPaymentConfig): Promise<RefundResult> {
    const failed: RefundResult = { success: false, refundId: '', amount, status: 'failed' };
    try {
      const r = await this.call(config, 'POST', `/transactions/${encodeURIComponent(paymentId)}/refund`, { amount });
      if (!r.ok || r.json?.status === 'error') {
        this.logger.warn(`Flutterwave refund rejected for ${paymentId} (HTTP ${r.status}): ${(r.json?.message ?? r.text).toString().slice(0, 200)}`);
        return failed;
      }
      const data = r.json?.data ?? {};
      const st = String(data.status ?? '').toLowerCase();
      const status: RefundResult['status'] =
        st.startsWith('completed') ? 'succeeded' : st.startsWith('pending') || st === 'processing' || st === 'initiated' ? 'pending' : 'failed';
      return { success: status !== 'failed', refundId: String(data.id ?? ''), amount, status };
    } catch (e: any) {
      this.logger.warn(`Flutterwave refund failed for ${paymentId}: ${e?.message ?? e}`);
      return failed;
    }
  }

  getPublicConfig(config: Record<string, any>) {
    return { displayName: config.displayName ?? 'Flutterwave', currency: config.currency ?? '', logo: config.logo };
  }
}
