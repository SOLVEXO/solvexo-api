/* eslint-disable prettier/prettier */
import { PaymentProviderRegistry } from './payment-provider.registry';
import { SafepayPaymentProvider } from './providers/safepay.provider';
import { StripePaymentProvider } from './providers/stripe-integration.provider';

describe('PaymentProviderRegistry', () => {
  let registry: PaymentProviderRegistry;
  let safepay: SafepayPaymentProvider;
  let stripe: StripePaymentProvider;

  beforeEach(() => {
    safepay = { providerKey: 'safepay' } as any;
    stripe = { providerKey: 'stripe' } as any;
    registry = new PaymentProviderRegistry(safepay, stripe);
  });

  it('resolves a registered provider to its concrete implementation', () => {
    expect(registry.resolve('safepay')).toBe(safepay);
    expect(registry.resolve('stripe')).toBe(stripe);
  });

  it('reports supported vs unsupported providers — checkout/seller-facing code uses this to hide unimplemented gateways', () => {
    expect(registry.isSupported('safepay')).toBe(true);
    expect(registry.isSupported('stripe')).toBe(true);
    expect(registry.isSupported('jazzcash')).toBe(false);
    expect(registry.isSupported('easypaisa')).toBe(false);
  });

  it('throws a clear error resolving an unregistered provider rather than returning undefined silently', () => {
    expect(() => registry.resolve('jazzcash')).toThrow('No payment provider implementation registered for "jazzcash"');
  });
});
