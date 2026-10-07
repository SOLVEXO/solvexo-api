/* eslint-disable prettier/prettier */
import { createCipheriv } from 'crypto';

/**
 * Easypaisa (Telenor Microfinance Bank) "Easypay" hosted checkout — SIGNING HELPER ONLY, deliberately NOT a
 * `PaymentProvider` and NOT registered in `PaymentProviderRegistry`.
 *
 * What is implemented (from public Easypay sample code, unverified against the sandbox): the request hash
 * `merchantHashedReq` = base64(AES-128-ECB(hashKey, "k1=v1&k2=v2..." over the non-empty request params in
 * alphabetical key order, excluding the hash itself)) and the form field set for `Index.jsf`
 * (`easypaystg.easypaisa.com.pk` sandbox / `easypay.easypaisa.com.pk` live).
 *
 * What is NOT implemented, and why registering it would be unsafe: the two-step confirm hand-off
 * (`auth_token` -> `Confirm.jsf`), the final callback field names, any callback authenticity check and the
 * transaction-inquiry API are not in any publicly reachable Easypay document (the integration guide is behind the
 * merchant portal), and the only callback we could identify is an UNSIGNED browser redirect. Finalizing orders from
 * that would let anyone mark an order paid. Until the real guide (callback signature / inquiry endpoint) is
 * available, Easypaisa stays hidden from the seller and buyer UI. Sellers can still accept Easypaisa through the
 * bank-transfer / custom manual payment method (they receive money in their own account and approve it by hand).
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
