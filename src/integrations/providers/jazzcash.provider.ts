/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
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
 * JazzCash (Jazz Pakistan) "Page Redirection" hosted checkout, PKR only.
 *
 * VERIFICATION STATUS — read before going live:
 *  - JazzCash's official integration guide sits behind a merchant-portal login and could not be fetched. The
 *    request fields, the secure-hash recipe (HMAC-SHA256 keyed by the Integrity Salt over
 *    `salt & <non-empty pp_* values sorted by field name>`), the paisa amount unit, `pp_ResponseCode 000 = success`
 *    and the sandbox/live hosts come from JazzCash's published sample code and independent open-source
 *    integrations. The `PaymentInquiry/Inquire` endpoint/field names are the least certain part.
 *  - NOT run against the JazzCash sandbox. Hash logic is covered by unit tests against our own implementation
 *    only; test against a real sandbox merchant (and its response samples) before enabling for buyers.
 *
 * Flow: we return `formFields` + `redirectUrl` (the gateway form action) and the storefront auto-POSTs them. The
 * buyer's browser is POSTed back to `pp_ReturnURL`, which is OUR webhook-return route
 * (`/webhooks/payments/jazzcash/:token/return`): the signed response is verified there (amount + status are inside
 * the hash, so the callback is authoritative) and the buyer is then redirected to the storefront return page.
 */
@Injectable()
export class JazzCashPaymentProvider implements PaymentProvider {
  readonly providerKey = 'jazzcash' as const;
  readonly callbackIsAuthoritative = true;
  private readonly logger = new Logger(JazzCashPaymentProvider.name);

  private host(mode: 'sandbox' | 'live'): string {
    return mode === 'live' ? 'https://payments.jazzcash.com.pk' : 'https://sandbox.jazzcash.com.pk';
  }

  /** HMAC-SHA256(salt, `salt&v1&v2...`) over the non-empty pp_ fields sorted by field name, upper-case hex. */
  static computeSecureHash(fields: Record<string, string | undefined | null>, integritySalt: string): string {
    const keys = Object.keys(fields)
      .filter((k) => k !== 'pp_SecureHash' && k.startsWith('pp') && fields[k] !== undefined && fields[k] !== null && String(fields[k]) !== '')
      .sort();
    const message = [integritySalt, ...keys.map((k) => String(fields[k]))].join('&');
    return createHmac('sha256', integritySalt).update(message).digest('hex').toUpperCase();
  }

  static verifySecureHash(fields: Record<string, string>, integritySalt: string): boolean {
    const provided = String(fields.pp_SecureHash ?? '').toUpperCase();
    if (!provided || !integritySalt) return false;
    const expected = JazzCashPaymentProvider.computeSecureHash(fields, integritySalt);
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** yyyyMMddHHmmss in Pakistan time (UTC+5). */
  static pktTimestamp(date: Date): string {
    const d = new Date(date.getTime() + 5 * 3600_000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  }

  static mapResponseCode(code: string | undefined): PaymentStatus['status'] {
    if (code === '000') return 'paid';
    if (code === '121' || code === '124') return 'pending'; // pending / waiting for the buyer to authorise
    return 'failed';
  }

  private creds(config: DecryptedPaymentConfig) {
    const { merchantId, password, integritySalt } = config.credentials ?? {};
    if (!merchantId || !password || !integritySalt) throw new Error('JazzCash merchant id, password and integrity salt are required');
    return { merchantId: String(merchantId), password: String(password), integritySalt: String(integritySalt) };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- builds a signed form locally; async to satisfy the shared interface
  async initiatePayment(order: PaymentOrderContext, config: DecryptedPaymentConfig): Promise<PaymentSession> {
    const { merchantId, password, integritySalt } = this.creds(config);
    if (!config.webhookToken) throw new Error('JazzCash integration has no webhook token');
    if (order.currency.toUpperCase() !== 'PKR') throw new Error('JazzCash only supports PKR');

    const now = new Date();
    const txnRef = `T${JazzCashPaymentProvider.pktTimestamp(now)}${String(randomInt(0, 10000)).padStart(4, '0')}`; // 19 chars, unique per attempt
    const fields: Record<string, string> = {
      pp_Version: '1.1',
      pp_TxnType: String(config.config?.txnType ?? ''),
      pp_Language: 'EN',
      pp_MerchantID: merchantId,
      pp_SubMerchantID: '',
      pp_Password: password,
      pp_BankID: String(config.config?.bankId ?? 'TBANK'),
      pp_ProductID: String(config.config?.productId ?? 'RETL'),
      pp_TxnRefNo: txnRef,
      pp_Amount: String(Math.round(order.amount * 100)),
      pp_TxnCurrency: 'PKR',
      pp_TxnDateTime: JazzCashPaymentProvider.pktTimestamp(now),
      pp_BillReference: 'billRef',
      pp_Description: `Order ${order.orderId}`.slice(0, 200),
      pp_TxnExpiryDateTime: JazzCashPaymentProvider.pktTimestamp(new Date(now.getTime() + 3600_000)),
      pp_ReturnURL: `${API_PUBLIC_ORIGIN}/webhooks/payments/jazzcash/${config.webhookToken}/return`,
    };
    fields.pp_SecureHash = JazzCashPaymentProvider.computeSecureHash(fields, integritySalt);

    return {
      redirectUrl: `${this.host(config.mode)}/CustomerPortal/transactionmanagement/merchantform/`,
      formFields: fields,
      sessionId: txnRef,
    };
  }

  /** Status inquiry — endpoint/field names UNVERIFIED (see class doc); a failure here never produces `paid`. */
  async verifyPayment(reference: string, config: DecryptedPaymentConfig): Promise<PaymentStatus> {
    const { merchantId, password, integritySalt } = this.creds(config);
    const body: Record<string, string> = { pp_TxnRefNo: reference, pp_MerchantID: merchantId, pp_Password: password };
    body.pp_SecureHash = JazzCashPaymentProvider.computeSecureHash(body, integritySalt);
    const res = await fetch(`${this.host(config.mode)}/ApplicationAPI/API/PaymentInquiry/Inquire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`JazzCash inquiry failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const data: Record<string, string> = await res.json();
    if (data.pp_SecureHash && !JazzCashPaymentProvider.verifySecureHash(data, integritySalt)) {
      throw new Error('JazzCash inquiry response failed hash verification');
    }
    const paid = data.pp_PaymentResponseCode === '000' || data.pp_Status === 'Completed';
    const amountPaisa = Number(data.pp_Amount);
    return {
      status: paid ? 'paid' : data.pp_Status === 'Failed' ? 'failed' : 'pending',
      providerReference: reference,
      amount: Number.isFinite(amountPaisa) && amountPaisa > 0 ? amountPaisa / 100 : undefined,
      currency: data.pp_TxnCurrency ?? 'PKR',
      raw: data,
    };
  }

  /** Parses the signed `application/x-www-form-urlencoded` response JazzCash POSTs to pp_ReturnURL. */
  // eslint-disable-next-line @typescript-eslint/require-await -- HMAC verification is synchronous; async for the shared interface
  async handleWebhook(rawBody: Buffer, _headers: Record<string, string>, config: DecryptedPaymentConfig): Promise<PaymentEvent> {
    const { integritySalt } = this.creds(config);
    const fields: Record<string, string> = {};
    new URLSearchParams(rawBody.toString('utf8')).forEach((v, k) => { fields[k] = v; });
    if (!fields.pp_SecureHash) throw new Error('Missing pp_SecureHash');
    if (!JazzCashPaymentProvider.verifySecureHash(fields, integritySalt)) throw new Error('JazzCash secure hash mismatch');
    if (!fields.pp_TxnRefNo) throw new Error('Missing pp_TxnRefNo');

    const status = JazzCashPaymentProvider.mapResponseCode(fields.pp_ResponseCode);
    const amount = Number(fields.pp_Amount) / 100;
    return {
      type: status === 'paid' ? 'payment_succeeded' : status === 'failed' ? 'payment_failed' : 'payment_pending',
      externalEventId: `${fields.pp_TxnRefNo}:${fields.pp_ResponseCode}`,
      sessionId: fields.pp_TxnRefNo,
      status: {
        status,
        providerReference: fields.pp_TxnRefNo,
        amount: Number.isFinite(amount) && fields.pp_Amount ? amount : undefined,
        currency: fields.pp_TxnCurrency || 'PKR',
        raw: fields,
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no refund API is wired (JazzCash refunds are issued from the merchant portal)
  async refund(_transactionId: string, amount: number): Promise<RefundResult> {
    this.logger.warn('JazzCash refunds are not automated — refund from the JazzCash merchant portal');
    return { success: false, refundId: '', amount, status: 'failed' };
  }

  /**
   * Gateway round-trip: a signed inquiry for a reference that cannot exist. A wrong merchant id / password / salt
   * is rejected by JazzCash before the lookup, so the response text tells the seller which. Heuristic — the
   * gateway's own code/message is always echoed so the seller sees the real answer.
   */
  async testConnection(config: DecryptedPaymentConfig) {
    let creds;
    try { creds = this.creds(config); } catch (e: any) { return { ok: false, message: e.message }; }
    const body: Record<string, string> = { pp_TxnRefNo: 'T00000000000000000', pp_MerchantID: creds.merchantId, pp_Password: creds.password };
    body.pp_SecureHash = JazzCashPaymentProvider.computeSecureHash(body, creds.integritySalt);
    try {
      const res = await fetch(`${this.host(config.mode)}/ApplicationAPI/API/PaymentInquiry/Inquire`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
      });
      const text = await res.text();
      let data: Record<string, string> = {};
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      if (!res.ok || !data.pp_ResponseCode) {
        return { ok: false, message: `JazzCash ${config.mode} did not answer the credential check as expected (HTTP ${res.status}): ${text.slice(0, 160)}` };
      }
      const msg = `${data.pp_ResponseCode} ${data.pp_ResponseMessage ?? ''}`.trim();
      const looksLikeAuthFailure = /hash|merchant|password|credential|unauthori|invalid/i.test(data.pp_ResponseMessage ?? '');
      return looksLikeAuthFailure
        ? { ok: false, message: `JazzCash ${config.mode} rejected the credentials: ${msg}` }
        : { ok: true, message: `JazzCash ${config.mode} answered a signed request (${msg})` };
    } catch (err: any) {
      return { ok: false, message: `Could not reach JazzCash: ${err?.message ?? 'network error'}` };
    }
  }

  getPublicConfig(config: Record<string, any>) {
    return { displayName: config.displayName ?? 'JazzCash', currency: 'PKR' as const, logo: config.logo };
  }
}
