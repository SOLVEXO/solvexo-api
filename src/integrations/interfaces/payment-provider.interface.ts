/* eslint-disable prettier/prettier */
import { StoreIntegrationProvider } from '../schemas/store-integration.schema';

/** What checkout gets back after asking a provider to start a payment. */
export interface PaymentSession {
  /** Hosted-checkout redirect (Safepay, JazzCash, Easypaisa, PayFast). */
  redirectUrl?: string;
  /** Form fields the client posts directly to the gateway (JazzCash-style signed form flow). */
  formFields?: Record<string, string>;
  /** Client-side SDK token (Stripe PaymentIntent client secret). */
  clientToken?: string;
  /** The provider's own identifier for this attempt (tracker token, PaymentIntent id, order id) — stored on the order and used for verify/refund lookups. */
  sessionId: string;
}

export type PaymentEventType = 'payment_succeeded' | 'payment_failed' | 'refund_succeeded' | 'refund_failed';

export interface PaymentStatus {
  status: 'pending' | 'paid' | 'failed' | 'refunded';
  providerReference: string;
  amount?: number;
  /** Real, dynamic currency code (see the Markets architecture), not a fixed
   *  literal union. */
  currency?: string;
  raw?: Record<string, any>;
}

export interface PaymentEvent {
  type: PaymentEventType;
  /** Provider's own event id — the idempotency key for `IntegrationWebhookEvent`. */
  externalEventId: string;
  sessionId: string;
  status: PaymentStatus;
}

export interface RefundResult {
  success: boolean;
  refundId: string;
  amount: number;
  status: 'pending' | 'succeeded' | 'failed';
}

export interface PublicPaymentMethodView {
  provider: StoreIntegrationProvider;
  displayName: string;
  /** Real, dynamic currency code — not a fixed literal union (see the
   *  Markets architecture); a store's real `baseCurrency`. */
  currency: string;
  logo?: string;
}

/** Decrypted, in-memory-only view of a StoreIntegration — never persisted or logged as-is. */
export interface DecryptedPaymentConfig {
  credentials: Record<string, any>;
  config: Record<string, any>;
  mode: 'sandbox' | 'live';
  webhookToken: string | null;
}

export interface PaymentOrderContext {
  orderId: string;
  /** Store's bound currency amount, in that currency's major unit (rupees / dollars) — each provider converts to whatever minor/major unit its own API expects. */
  amount: number;
  /** Real, dynamic currency code — not a fixed literal union any more (see
   *  the Markets architecture). Safepay/JazzCash/Easypaisa/PayFast are still
   *  genuinely PKR-only local rails by design (their call sites only ever
   *  run for a PKR store), Stripe accepts any store currency. */
  currency: string;
  storeId: string;
  buyerEmail?: string;
  buyerPhone?: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface PaymentProvider {
  readonly providerKey: StoreIntegrationProvider;

  initiatePayment(order: PaymentOrderContext, config: DecryptedPaymentConfig): Promise<PaymentSession>;
  verifyPayment(reference: string, config: DecryptedPaymentConfig): Promise<PaymentStatus>;
  handleWebhook(rawBody: Buffer, headers: Record<string, string>, config: DecryptedPaymentConfig): Promise<PaymentEvent>;
  refund(transactionId: string, amount: number, config: DecryptedPaymentConfig): Promise<RefundResult>;
  /** Fields safe to hand to buyer-side checkout — never credentials. */
  getPublicConfig(config: Record<string, any>): Omit<PublicPaymentMethodView, 'provider'>;
}
