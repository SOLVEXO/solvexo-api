/* eslint-disable prettier/prettier */
/**
 * G2.1 — the provider-agnostic seam for POS digital payments (Raast QR first). Every real provider (PayFast, 1LINK 1GO, …) is one
 * adapter that implements this interface and must pass `payment-provider.contract.ts`. All amounts are integers in the currency's
 * minor unit; a provider never sees or returns a decimal.
 */

export type ProviderOutcomeKind =
  | 'pending' | 'confirmed' | 'failed' | 'expired'
  | 'refund_succeeded' | 'refund_failed';

/** What a provider tells us happened (from a webhook body or a status poll), already normalised. */
export interface ProviderOutcome {
  /** Provider's own unique id for this notification — the dedupe key. Null for a poll result (a poll is not a notification). */
  providerEventId: string | null;
  providerRef: string;
  kind: ProviderOutcomeKind;
  amountMinor: number | null;
  /** Set for refund outcomes: OUR refund id (the one we sent) so the outcome can be matched to its refund_requested event. */
  refundId?: string | null;
  providerRefundRef?: string | null;
  occurredAt: Date;
  reason?: string | null;
}

export interface CreateChargeInput {
  intentId: string;
  amountMinor: number;
  currency: string;
  currencyExponent: number;
  /** Our idempotency key for this charge; a provider that supports it must dedupe on it. */
  idempotencyKey: string;
  /** Provider sub-merchant (the store's onboarding reference) — settlement goes to that merchant's own bank account. */
  subMerchantRef: string;
  description: string;
  expiresAt: Date;
  /** Only the mock reads this: a scripted outcome for tests and demos. Real adapters ignore it. */
  mockScenario?: string | null;
}

export interface CreateChargeResult {
  providerRef: string;
  /** What the till renders as a QR code. */
  qrPayload: string;
  /** The provider's own expiry; we always use the EARLIER of this and ours. */
  expiresAt: Date;
}

export interface RefundInput {
  providerRef: string;
  refundId: string;
  amountMinor: number;
  currency: string;
  reason: string;
}

export interface RefundResult {
  status: 'succeeded' | 'pending' | 'failed';
  providerRefundRef: string | null;
  reason?: string | null;
}

export class WebhookSignatureError extends Error {
  constructor(message = 'Invalid webhook signature') { super(message); this.name = 'WebhookSignatureError'; }
}
export class WebhookReplayError extends Error {
  constructor(message = 'Webhook timestamp outside the allowed window') { super(message); this.name = 'WebhookReplayError'; }
}

export interface PaymentProvider {
  /** Registry key, e.g. 'mock', 'payfast', '1link'. Stored on every intent. */
  readonly key: string;
  /** How long the provider's own QR stays valid at most (seconds); our expiry is never longer. */
  readonly qrValiditySeconds: number;
  /** True if the provider calls our webhook; false means polling is the only way to learn the outcome. */
  readonly supportsWebhooks: boolean;

  createCharge(input: CreateChargeInput): Promise<CreateChargeResult>;
  /** Poll: the provider's current view of a charge (used for providers without webhooks and as a safety net for those with). */
  getStatus(providerRef: string): Promise<ProviderOutcome>;
  cancel(providerRef: string): Promise<void>;
  refund(input: RefundInput): Promise<RefundResult>;
  getRefundStatus(providerRef: string, refundId: string): Promise<ProviderOutcome | null>;

  /**
   * Verify the signature over the RAW body (before parsing), enforce the replay window, and return the normalised outcome.
   * Must throw `WebhookSignatureError` / `WebhookReplayError`; must compare in constant time.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, now: Date): ProviderOutcome;
}

export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');
