/* eslint-disable prettier/prettier */
/**
 * The store-level gate for digital payments: only a store whose KYB is `verified`, with a provider sub-merchant reference, may take a QR
 * payment. Cash and `recorded_unverified` card stay available to every store (they never pass through here). The implementation lives in
 * the KYB module (`KybGateService`); payments-core depends only on this interface.
 */
export interface DigitalPaymentsGate {
  /** Resolves with the store's sub-merchant reference, or throws `ForbiddenException({ code: 'STORE_NOT_VERIFIED', … })`. */
  assertEnabled(storeId: string): Promise<{ subMerchantRef: string }>;
  /** Non-throwing form for the app/UI (hide the button) — additive field on the subscription response later. */
  isEnabled(storeId: string): Promise<boolean>;
}
export const DIGITAL_PAYMENTS_GATE = Symbol('DIGITAL_PAYMENTS_GATE');
