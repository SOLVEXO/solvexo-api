/* eslint-disable prettier/prettier */
import { PaymentProviderRegistry } from './payment-provider.registry';
import { SafepayPaymentProvider } from './providers/safepay.provider';
import { StripePaymentProvider } from './providers/stripe-integration.provider';
import { JazzCashPaymentProvider } from './providers/jazzcash.provider';
import { PayFastPaymentProvider } from './providers/payfast.provider';

describe('PaymentProviderRegistry', () => {
  let registry: PaymentProviderRegistry;
  let safepay: SafepayPaymentProvider;
  let stripe: StripePaymentProvider;
  let jazzcash: JazzCashPaymentProvider;
  let payfast: PayFastPaymentProvider;

  beforeEach(() => {
    safepay = { providerKey: 'safepay' } as any;
    stripe = { providerKey: 'stripe' } as any;
    jazzcash = { providerKey: 'jazzcash' } as any;
    payfast = { providerKey: 'payfast' } as any;
    registry = new PaymentProviderRegistry(safepay, stripe, jazzcash, payfast);
  });

  it('resolves a registered provider to its concrete implementation', () => {
    expect(registry.resolve('safepay')).toBe(safepay);
    expect(registry.resolve('stripe')).toBe(stripe);
    expect(registry.resolve('jazzcash')).toBe(jazzcash);
    expect(registry.resolve('payfast')).toBe(payfast);
  });

  it('reports supported vs unsupported providers — checkout/seller-facing code uses this to hide unimplemented gateways', () => {
    expect(registry.isSupported('safepay')).toBe(true);
    expect(registry.isSupported('jazzcash')).toBe(true);
    expect(registry.isSupported('payfast')).toBe(true);
    expect(registry.isSupported('easypaisa')).toBe(false);
  });

  it('throws a clear error resolving an unregistered provider rather than returning undefined silently', () => {
    expect(() => registry.resolve('easypaisa')).toThrow('No payment provider implementation registered for "easypaisa"');
  });
});
