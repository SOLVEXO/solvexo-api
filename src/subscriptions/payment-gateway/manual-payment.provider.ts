/* eslint-disable prettier/prettier */
import { IPaymentGateway, ChargeResult, CreateProviderSubResult } from './payment-gateway.interface';

/**
 * ManualPaymentProvider — mock/simulation provider.
 *
 * Always returns success so the full billing flow can be exercised end-to-end
 * without a real payment gateway. Replace with StripePaymentProvider by:
 *   1. Creating stripe-payment.provider.ts implementing IPaymentGateway
 *   2. Setting PAYMENT_PROVIDER=stripe in .env
 */
export class ManualPaymentProvider implements IPaymentGateway {
  private fakeId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  async chargeSubscription(subscriptionId: string, amountUSD: number): Promise<ChargeResult> {
    const providerChargeId = this.fakeId('manual_chg');
    console.log(`[ManualPayment] Simulated charge: $${amountUSD.toFixed(2)} USD | sub=${subscriptionId} | chargeId=${providerChargeId}`);
    return { success: true, providerChargeId };
  }

  async createProviderSubscription(
    subscriptionId: string,
    planName: string,
    amountUSD: number,
    interval: string,
  ): Promise<CreateProviderSubResult> {
    const providerSubscriptionId = this.fakeId('manual_sub');
    console.log(`[ManualPayment] Simulated subscription: ${planName} $${amountUSD.toFixed(2)}/${interval} | sub=${subscriptionId} | provId=${providerSubscriptionId}`);
    return { providerSubscriptionId };
  }

  async cancelProviderSubscription(providerSubscriptionId: string): Promise<void> {
    console.log(`[ManualPayment] Simulated cancellation: provId=${providerSubscriptionId}`);
  }
}
