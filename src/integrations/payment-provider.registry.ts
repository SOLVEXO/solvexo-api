/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { StoreIntegrationProvider } from './schemas/store-integration.schema';
import { PaymentProvider } from './interfaces/payment-provider.interface';
import { SafepayPaymentProvider } from './providers/safepay.provider';
import { StripePaymentProvider } from './providers/stripe-integration.provider';

/**
 * Resolves a `StoreIntegration.provider` value to its concrete
 * implementation at runtime. Checkout/order code depends only on this
 * registry and the `PaymentProvider` interface — never on a concrete
 * gateway class — so adding gateway #5 (JazzCash/Easypaisa/PayFast) is one
 * new provider class plus one line here, with zero changes anywhere else.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly providers = new Map<StoreIntegrationProvider, PaymentProvider>();

  constructor(safepayProvider: SafepayPaymentProvider, stripeProvider: StripePaymentProvider) {
    this.providers.set(safepayProvider.providerKey, safepayProvider);
    this.providers.set(stripeProvider.providerKey, stripeProvider);
  }

  resolve(provider: StoreIntegrationProvider): PaymentProvider {
    const impl = this.providers.get(provider);
    if (!impl) {
      throw new Error(`No payment provider implementation registered for "${provider}"`);
    }
    return impl;
  }

  isSupported(provider: StoreIntegrationProvider): boolean {
    return this.providers.has(provider);
  }
}
