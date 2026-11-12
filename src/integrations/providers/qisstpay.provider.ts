/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import {
  ConnectionTestResult, DecryptedPaymentConfig, PaymentEvent, PaymentOrderContext, PaymentProvider, PaymentSession, PaymentStatus, RefundResult,
} from '../interfaces/payment-provider.interface';

export const QISSTPAY_UNVERIFIED = 'Qisstpay is not available yet: its integration has not been verified against the official documentation or a sandbox account.';

/**
 * VERIFY AGAINST OFFICIAL DOC: everything about Qisstpay's real API (endpoints, auth, checkout redirect, webhook signature,
 * status names, installment plans, minimum/maximum order value) is UNKNOWN here. Nothing is invented. This adapter exists so the
 * provider has its place in the registry and the catalog; it is switched OFF and refuses to charge until the field names are filled
 * in by the single mapping point below (`mapQisstpay*`) from the merchant integration guide and tested in their sandbox.
 * See docs/parity/OPEN-QUESTIONS.md (P7).
 */
@Injectable()
export class QisstpayPaymentProvider implements PaymentProvider {
  readonly providerKey = 'qisstpay' as const;
  readonly callbackIsAuthoritative = false;
  readonly verified = false;

  async testConnection(_config: DecryptedPaymentConfig): Promise<ConnectionTestResult> { return { ok: false, message: QISSTPAY_UNVERIFIED }; }
  async initiatePayment(_order: PaymentOrderContext, _config: DecryptedPaymentConfig): Promise<PaymentSession> { throw new Error(QISSTPAY_UNVERIFIED); }
  async verifyPayment(_reference: string, _config: DecryptedPaymentConfig): Promise<PaymentStatus> { throw new Error(QISSTPAY_UNVERIFIED); }
  async handleWebhook(_raw: Buffer, _headers: Record<string, string>, _config: DecryptedPaymentConfig): Promise<PaymentEvent> { throw new Error(QISSTPAY_UNVERIFIED); }
  async refund(_id: string, _amount: number, _config: DecryptedPaymentConfig): Promise<RefundResult> { throw new Error('Refund Qisstpay orders in the Qisstpay merchant portal.'); }
  getPublicConfig(_config: Record<string, any>) { return { displayName: 'Pay in installments (Qisstpay)', currency: 'PKR' }; }
}

/** Only wording for the storefront ("pay in N installments"), shown ONLY when a verified, enabled Qisstpay integration exists. No fees or rates are stated. */
export function installmentMessage(total: number, currency: string, parts = 3): string | null {
  if (!(total > 0) || parts < 2) return null;
  const each = Math.ceil((total / parts) * 100) / 100;
  return `Or pay in ${parts} installments of ${currency} ${each.toLocaleString('en-US')}`;
}
