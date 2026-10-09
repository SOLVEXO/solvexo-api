/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, randomBytes } from 'crypto';
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
 * Easypaisa (Telenor Microfinance Bank) "Easypay" hosted checkout — SIGNING HELPER ONLY. The hosted page flow is
 * NOT used: its only result is an UNSIGNED browser redirect and its guide is behind the merchant portal, so
 * finalizing orders from it would let anyone mark an order paid. Kept (with its spec) in case the hosted flow is
 * ever needed; payments go through `EasypaisaPaymentProvider` below instead.
 *
 * `merchantHashedReq` = base64(AES-128-ECB(hashKey, "k1=v1&k2=v2..." over the non-empty request params in
 * alphabetical key order, excluding the hash itself)); hosts `easypaystg.easypaisa.com.pk` / `easypay.easypaisa.com.pk`.
 */
export class EasypaisaRequestSigner {
  static host(mode: 'sandbox' | 'live'): string {
    return mode === 'live' ? 'https://easypay.easypaisa.com.pk' : 'https://easypaystg.easypaisa.com.pk';
  }

  /** `k=v&k=v` over non-empty params, alphabetical by key. */
  static canonicalQuery(params: Record<string, string | number | undefined | null>): string {
    return Object.keys(params)
      .filter((k) => k !== 'merchantHashedReq' && params[k] !== undefined && params[k] !== null && String(params[k]) !== '')
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
  }

  static merchantHashedReq(params: Record<string, string | number | undefined | null>, hashKey: string): string {
    const key = Buffer.from(hashKey, 'utf8');
    if (key.length !== 16) throw new Error('Easypaisa hash key must be 16 characters (AES-128)');
    const cipher = createCipheriv('aes-128-ecb', key, null);
    return Buffer.concat([cipher.update(EasypaisaRequestSigner.canonicalQuery(params), 'utf8'), cipher.final()]).toString('base64');
  }
}

/** Easypaisa REST response codes (Easypay REST v4). */
const RESPONSE_CODES: Record<string, string> = {
  '0000': 'Success',
  '0001': 'System error',
  '0002': 'Required field missing',
  '0003': 'Invalid order id',
  '0004': 'Invalid merchant account number',
  '0005': 'Merchant account not active',
  '0006': 'Invalid store id',
  '0007': 'Store not active',
  '0008': 'Payment method not enabled',
  '0010': 'Invalid credentials',
  '0013': 'Low balance',
  '0014': 'Account does not exist',
};

/** Normalises a Pakistani mobile number to Easypaisa's `03XXXXXXXXX` account format, or null if it isn't one. */
export function toEasypaisaMobileAccount(raw: string | undefined | null): string | null {
  const digits = String(raw ?? '').replace(/[\s-]/g, '').replace(/^(\+92|0092|92)/, '0');
  return /^03\d{9}$/.test(digits) ? digits : null;
}

/**
 * Easypaisa mobile-account (MA) payments over the Easypay REST v4 API, PKR only. NOT the hosted page (see above).
 *
 * Flow — no browser redirect to Easypaisa, no callback to trust:
 *  1. `initiatePayment` opens a session (our order id) and sends the buyer to the storefront return page, which
 *     tells them to approve the payment in their Easypaisa app and polls the checkout status.
 *  2. `startPushPayment` (run in the background by CheckoutPaymentMethodsService) calls
 *     `initiate-ma-transaction`; Easypaisa pushes an approval request to the buyer's Easypaisa app and answers when
 *     the buyer approves, declines or the request times out.
 *  3. The result is only ever taken from `inquire-transaction` (`verifyPayment`) — a server-to-server call
 *     authenticated with the merchant's own API credentials that returns the real status AND amount, which the
 *     shared checks compare with what we charged before an order is created. The hourly stuck-payment check
 *     re-runs the same inquiry if the background step was interrupted.
 *
 * VERIFICATION STATUS: endpoints, field names, the `Credentials` header (base64 "username:password") and response
 * codes come from open-source Easypay REST v4 integrations, not from the merchant-portal guide, and this was NOT run
 * against the Easypaisa sandbox. Test with real sandbox credentials before enabling for buyers.
 */
@Injectable()
export class EasypaisaPaymentProvider implements PaymentProvider {
  readonly providerKey = 'easypaisa' as const;
  // No callback at all — every result comes from the authenticated inquiry API.
  readonly callbackIsAuthoritative = false;
  private readonly logger = new Logger(EasypaisaPaymentProvider.name);

  private creds(config: DecryptedPaymentConfig) {
    const { easypaisaStoreId, accountNum, username, password } = config.credentials ?? {};
    if (!easypaisaStoreId || !accountNum || !username || !password) {
      throw new Error('Easypaisa store id, merchant account number, API username and password are required');
    }
    return { storeId: String(easypaisaStoreId), accountNum: String(accountNum), username: String(username), password: String(password) };
  }

  private async post(config: DecryptedPaymentConfig, path: string, body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, any>> {
    const { username, password } = this.creds(config);
    const res = await fetch(`${EasypaisaRequestSigner.host(config.mode)}/easypay-service/rest/v4/${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Credentials: Buffer.from(`${username}:${password}`, 'utf8').toString('base64'),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Easypaisa ${path} failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Easypaisa ${path} returned a non-JSON response: ${text.slice(0, 200)}`);
    }
  }

  private static describe(code: string | undefined, desc?: string): string {
    return `${code ?? '????'} ${desc ?? RESPONSE_CODES[code ?? ''] ?? 'Unknown response'}`.trim();
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- only opens a local session; the gateway call is startPushPayment
  async initiatePayment(order: PaymentOrderContext, config: DecryptedPaymentConfig): Promise<PaymentSession> {
    this.creds(config);
    if (order.currency.toUpperCase() !== 'PKR') throw new Error('Easypaisa only supports PKR');
    if (!(order.amount > 0)) throw new Error('Nothing to pay');
    if (!toEasypaisaMobileAccount(order.walletAccount ?? order.buyerPhone)) {
      throw new Error('Enter the mobile number of your Easypaisa account (03XXXXXXXXX)');
    }
    const sessionId = `SX${Date.now().toString(36)}${randomBytes(3).toString('hex')}`.toUpperCase();
    const back = new URL(order.returnUrl);
    back.searchParams.set('wallet', 'easypaisa');
    return { sessionId, redirectUrl: back.toString() };
  }

  async startPushPayment(order: PaymentOrderContext, sessionId: string, config: DecryptedPaymentConfig): Promise<void> {
    const { storeId, accountNum } = this.creds(config);
    const mobile = toEasypaisaMobileAccount(order.walletAccount ?? order.buyerPhone);
    if (!mobile) throw new Error('Invalid Easypaisa mobile account number');
    const data = await this.post(config, 'initiate-ma-transaction', {
      orderId: sessionId,
      storeId,
      accountNum,
      transactionAmount: (Math.round(order.amount * 100) / 100).toFixed(2),
      transactionType: 'MA',
      mobileAccountNo: mobile,
      emailAddress: order.buyerEmail || undefined,
    }, 3 * 60_000);
    if (data.responseCode !== '0000') {
      this.logger.warn(`Easypaisa MA payment ${sessionId} not approved: ${EasypaisaPaymentProvider.describe(data.responseCode, data.responseDesc)}`);
    }
  }

  async verifyPayment(reference: string, config: DecryptedPaymentConfig): Promise<PaymentStatus> {
    const { storeId, accountNum } = this.creds(config);
    const data = await this.post(config, 'inquire-transaction', { orderId: reference, storeId, accountNum }, 30_000);
    if (data.responseCode !== '0000') {
      // Inquiry itself failed (unknown order yet, credentials, outage) — not a payment result.
      return { status: 'pending', providerReference: reference, raw: data };
    }
    const txnStatus = String(data.transactionStatus ?? '').toUpperCase();
    const status: PaymentStatus['status'] =
      txnStatus === 'PAID' ? 'paid'
        : txnStatus === 'REVERSED' ? 'refunded'
          : txnStatus === 'FAILED' || txnStatus === 'EXPIRED' || txnStatus === 'BLOCKED' ? 'failed'
            : 'pending';
    // Easypaisa doesn't echo the merchant on the order id — a session from another merchant's store must not pass.
    if (data.storeId && String(data.storeId) !== storeId) {
      return { status: 'failed', providerReference: reference, raw: data };
    }
    const amount = Number(data.transactionAmount);
    return { status, providerReference: reference, amount: Number.isFinite(amount) ? amount : undefined, currency: 'PKR', raw: data };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- Easypaisa MA has no callback; async for the shared interface
  async handleWebhook(): Promise<PaymentEvent> {
    throw new Error('Easypaisa results are read from the inquiry API, not from callbacks');
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- refunds are issued from the Easypaisa merchant portal
  async refund(_transactionId: string, amount: number): Promise<RefundResult> {
    this.logger.warn('Easypaisa refunds are not automated — refund from the Easypaisa merchant portal');
    return { success: false, refundId: '', amount, status: 'failed' };
  }

  /** Real round-trip: an inquiry for an order id that can't exist. Credential/store/account problems come back as their own codes. */
  async testConnection(config: DecryptedPaymentConfig) {
    try {
      const { storeId, accountNum } = this.creds(config);
      const data = await this.post(config, 'inquire-transaction', { orderId: `SXTEST${Date.now().toString(36).toUpperCase()}`, storeId, accountNum }, 20_000);
      const code = String(data.responseCode ?? '');
      if (['0004', '0005', '0006', '0007', '0008', '0010'].includes(code)) {
        return { ok: false, message: `Easypaisa ${config.mode} rejected the credentials: ${EasypaisaPaymentProvider.describe(code, data.responseDesc)}` };
      }
      if (code === '0000' || code === '0003') {
        return { ok: true, message: `Easypaisa ${config.mode} accepted the store id, account number and API credentials` };
      }
      return { ok: false, message: `Easypaisa ${config.mode} answered unexpectedly: ${EasypaisaPaymentProvider.describe(code, data.responseDesc)}` };
    } catch (err: any) {
      return { ok: false, message: `Easypaisa ${config.mode} check failed: ${err?.message ?? 'network error'}` };
    }
  }

  getPublicConfig(config: Record<string, any>) {
    return { displayName: config.displayName ?? 'Easypaisa', currency: 'PKR' as const, logo: config.logo };
  }
}
