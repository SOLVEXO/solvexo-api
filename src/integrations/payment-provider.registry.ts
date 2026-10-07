/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { StoreIntegrationProvider } from './schemas/store-integration.schema';
import { PaymentProvider } from './interfaces/payment-provider.interface';
import { SafepayPaymentProvider } from './providers/safepay.provider';
import { StripePaymentProvider } from './providers/stripe-integration.provider';
import { JazzCashPaymentProvider } from './providers/jazzcash.provider';
import { PayFastPaymentProvider } from './providers/payfast.provider';

/**
 * Resolves a `StoreIntegration.provider` value to its concrete
 * implementation at runtime. Checkout/order code depends only on this
 * registry and the `PaymentProvider` interface — never on a concrete
 * gateway class — so adding another gateway is one
 * new provider class plus one line here, with zero changes anywhere else.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly providers = new Map<StoreIntegrationProvider, PaymentProvider>();

  constructor(
    safepayProvider: SafepayPaymentProvider,
    stripeProvider: StripePaymentProvider,
    jazzcashProvider: JazzCashPaymentProvider,
    payfastProvider: PayFastPaymentProvider,
  ) {
    this.providers.set(safepayProvider.providerKey, safepayProvider);
    this.providers.set(stripeProvider.providerKey, stripeProvider);
    this.providers.set(jazzcashProvider.providerKey, jazzcashProvider);
    this.providers.set(payfastProvider.providerKey, payfastProvider);
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
