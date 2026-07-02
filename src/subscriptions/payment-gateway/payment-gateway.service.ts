/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IPaymentGateway, ChargeResult, CreateProviderSubResult } from './payment-gateway.interface';
import { ManualPaymentProvider } from './manual-payment.provider';

/**
 * PaymentGatewayService — delegates to the active provider selected via env.
 *
 * PAYMENT_PROVIDER=manual  → ManualPaymentProvider (default, no real charges)
 * PAYMENT_PROVIDER=stripe  → StripePaymentProvider (implement and wire when ready)
 *
 * Swap providers by setting the env variable — no other code changes needed.
 */
@Injectable()
export class PaymentGatewayService implements IPaymentGateway {
  private readonly provider: IPaymentGateway;

  constructor(config: ConfigService) {
    const providerName = config.get<string>('PAYMENT_PROVIDER') ?? 'manual';

    if (providerName === 'stripe') {
      // TODO: import StripePaymentProvider and wire it here once implemented
      // this.provider = new StripePaymentProvider(config);
      throw new Error('Stripe provider not yet implemented. Set PAYMENT_PROVIDER=manual in .env');
    } else {
      this.provider = new ManualPaymentProvider();
    }
  }

  chargeSubscription(subscriptionId: string, amountUSD: number): Promise<ChargeResult> {
    return this.provider.chargeSubscription(subscriptionId, amountUSD);
  }

  createProviderSubscription(
    subscriptionId: string,
    planName: string,
    amountUSD: number,
    interval: string,
  ): Promise<CreateProviderSubResult> {
    return this.provider.createProviderSubscription(subscriptionId, planName, amountUSD, interval);
  }

  cancelProviderSubscription(providerSubscriptionId: string): Promise<void> {
    return this.provider.cancelProviderSubscription(providerSubscriptionId);
  }
}
