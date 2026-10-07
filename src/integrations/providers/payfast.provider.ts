/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { API_PUBLIC_ORIGIN } from '../../common/api-origin';
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
 * PayFast Pakistan (PayFast by APPS, `ipg1.apps.net.pk`) hosted checkout, PKR only. NOT the South African PayFast.
 *
 * VERIFICATION STATUS — read before going live:
 *  - The PayFast Merchant Integration Guide is not publicly fetchable (merchant portal / 403). What is implemented
 *    comes from open-source integrations of that guide: `Transaction/GetAccessToken` (form POST of MERCHANT_ID,
 *    SECURED_KEY, BASKET_ID, TXNAMT, CURRENCY_CODE -> ACCESS_TOKEN), the hosted form POST to
 *    `Transaction/PostTransaction` (MERCHANT_ID, MERCHANT_NAME, TOKEN, PROCCODE 00, TXNAMT, BASKET_ID, SUCCESS_URL,
 *    FAILURE_URL, CHECKOUT_URL, ...), the sandbox `ipguat.apps.net.pk` / live `ipg1.apps.net.pk` hosts, and the IPN
 *    `validation_hash = SHA256("basket_id|secured_key|merchant_id|err_code")` with `err_code 000` = approved.
 *  - NOT run against the PayFast sandbox.
 *  - The IPN hash does NOT cover the amount, and no transaction-inquiry endpoint could be confirmed, so the paid
 *    AMOUNT is not independently verifiable here. The only protection is that TXNAMT is bound server-side when the
 *    access token is issued and the verified IPN names OUR basket id (= the stored session). `verifyPayment`
 *    therefore returns `pending` (no inquiry) and `handleWebhook` deliberately reports NO amount, so the shared
 *    amount check is skipped rather than fed an unauthenticated number. Add an inquiry call once the guide is in hand.
 */
@Injectable()
export class PayFastPaymentProvider implements PaymentProvider {
  readonly providerKey = 'payfast' as const;
  readonly callbackIsAuthoritative = true;
  private readonly logger = new Logger(PayFastPaymentProvider.name);

  private host(mode: 'sandbox' | 'live'): string {
    return mode === 'live' ? 'https://ipg1.apps.net.pk' : 'https://ipguat.apps.net.pk';
  }

  /** sha256 hex of `basket_id|secured_key|merchant_id|err_code`. */
  static computeValidationHash(basketId: string, securedKey: string, merchantId: string, errCode: string): string {
    return createHash('sha256').update(`${basketId}|${securedKey}|${merchantId}|${errCode}`).digest('hex');
  }

  static verifyValidationHash(fields: Record<string, string>, securedKey: string, merchantId: string): boolean {
    const provided = String(fields.validation_hash ?? '').toLowerCase();
    if (!provided || !fields.basket_id) return false;
    const expected = PayFastPaymentProvider.computeValidationHash(fields.basket_id, securedKey, merchantId, fields.err_code ?? '');
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private creds(config: DecryptedPaymentConfig) {
    const { merchantId, securedKey } = config.credentials ?? {};
    if (!merchantId || !securedKey) throw new Error('PayFast merchant id and secured key are required');
    return { merchantId: String(merchantId), securedKey: String(securedKey), merchantName: String(config.config?.merchantName ?? config.config?.displayName ?? 'Store') };
  }

  private async fetchToken(config: DecryptedPaymentConfig, basketId: string, amount: number): Promise<string> {
    const { merchantId, securedKey } = this.creds(config);
    const res = await fetch(`${this.host(config.mode)}/Ecommerce/api/Transaction/GetAccessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        MERCHANT_ID: merchantId, SECURED_KEY: securedKey, BASKET_ID: basketId, TXNAMT: String(amount), CURRENCY_CODE: 'PKR',
      }).toString(),
    });
    if (!res.ok) throw new Error(`PayFast token request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const token: string | undefined = data?.ACCESS_TOKEN ?? data?.access_token;
    if (!token) throw new Error(`PayFast did not return an access token${data?.MESSAGE ? `: ${data.MESSAGE}` : ''}`);
    return token;
  }

  async initiatePayment(order: PaymentOrderContext, config: DecryptedPaymentConfig): Promise<PaymentSession> {
    const { merchantId, merchantName } = this.creds(config);
    if (!config.webhookToken) throw new Error('PayFast integration has no webhook token');
    if (order.currency.toUpperCase() !== 'PKR') throw new Error('PayFast only supports PKR');
    if (!order.buyerPhone) throw new Error('PayFast requires the buyer mobile number');

    const basketId = `SX${Date.now().toString(36)}${randomBytes(4).toString('hex')}`.toUpperCase();
    const amount = Math.round(order.amount * 100) / 100;
    const token = await this.fetchToken(config, basketId, amount);

    const fields: Record<string, string> = {
      CURRENCY_CODE: 'PKR',
      MERCHANT_ID: merchantId,
      MERCHANT_NAME: merchantName,
      TOKEN: token,
      PROCCODE: '00',
      TXNAMT: String(amount),
      CUSTOMER_MOBILE_NO: order.buyerPhone,
      CUSTOMER_EMAIL_ADDRESS: order.buyerEmail ?? '',
      SIGNATURE: randomBytes(8).toString('hex'),
      VERSION: 'SOLVEXO-1.0',
      TXNDESC: `Order ${order.orderId}`.slice(0, 200),
      SUCCESS_URL: order.returnUrl,
      FAILURE_URL: order.cancelUrl,
      BASKET_ID: basketId,
      ORDER_DATE: new Date().toISOString().replace('T', ' ').slice(0, 19),
      CHECKOUT_URL: `${API_PUBLIC_ORIGIN}/webhooks/payments/payfast/${config.webhookToken}`,
    };
    return { redirectUrl: `${this.host(config.mode)}/Ecommerce/api/Transaction/PostTransaction`, formFields: fields, sessionId: basketId };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no inquiry endpoint is wired (see class doc)
  async verifyPayment(reference: string): Promise<PaymentStatus> {
    return { status: 'pending', providerReference: reference };
  }

  /** The IPN (GET query or POST form) — raw body is the urlencoded parameter string. */
  // eslint-disable-next-line @typescript-eslint/require-await -- hash verification is synchronous; async for the shared interface
  async handleWebhook(rawBody: Buffer, _headers: Record<string, string>, config: DecryptedPaymentConfig): Promise<PaymentEvent> {
    const { merchantId, securedKey } = this.creds(config);
    const fields: Record<string, string> = {};
    new URLSearchParams(rawBody.toString('utf8')).forEach((v, k) => { fields[k] = v; });
    if (!PayFastPaymentProvider.verifyValidationHash(fields, securedKey, merchantId)) {
      throw new Error('PayFast validation_hash mismatch');
    }
    const paid = fields.err_code === '000' || fields.err_code === '00';
    return {
      type: paid ? 'payment_succeeded' : 'payment_failed',
      externalEventId: `${fields.basket_id}:${fields.transaction_id ?? ''}:${fields.err_code}`,
      sessionId: fields.basket_id,
      // No amount on purpose — not covered by the hash (see class doc).
      status: { status: paid ? 'paid' : 'failed', providerReference: fields.basket_id, currency: 'PKR', raw: fields },
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- refunds are issued from the PayFast merchant portal
  async refund(_transactionId: string, amount: number): Promise<RefundResult> {
    this.logger.warn('PayFast refunds are not automated — refund from the PayFast merchant portal');
    return { success: false, refundId: '', amount, status: 'failed' };
  }

  /** Real round-trip: request an access token for PKR 1 — PayFast validates MERCHANT_ID/SECURED_KEY before issuing it. */
  async testConnection(config: DecryptedPaymentConfig) {
    try {
      this.creds(config);
      await this.fetchToken(config, `SXTEST${Date.now().toString(36).toUpperCase()}`, 1);
      return { ok: true, message: `PayFast ${config.mode} accepted the merchant id and secured key (access token issued)` };
    } catch (err: any) {
      return { ok: false, message: `PayFast ${config.mode} check failed: ${err?.message ?? 'network error'}` };
    }
  }

  getPublicConfig(config: Record<string, any>) {
    return { displayName: config.displayName ?? 'PayFast', currency: 'PKR' as const, logo: config.logo };
  }
}
