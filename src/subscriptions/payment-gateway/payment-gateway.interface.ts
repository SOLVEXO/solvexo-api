/* eslint-disable prettier/prettier */

export interface ChargeResult {
  success: boolean;
  providerChargeId: string;
  failureReason?: string;
}

export interface CreateProviderSubResult {
  providerSubscriptionId: string;
}

/**
 * IPaymentGateway — implement this interface for any payment provider.
 *
 * Current provider: ManualPaymentProvider (simulates success, no real charging).
 * Future provider:  StripePaymentProvider — implement this same interface,
 *                   then set PAYMENT_PROVIDER=stripe in .env.
 */
export interface IPaymentGateway {
  chargeSubscription(
    subscriptionId: string,
    amountUSD: number,
  ): Promise<ChargeResult>;

  createProviderSubscription(
    subscriptionId: string,
    planName: string,
    amountUSD: number,
    interval: string,
  ): Promise<CreateProviderSubResult>;

  cancelProviderSubscription(providerSubscriptionId: string): Promise<void>;
}
