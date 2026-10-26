/* eslint-disable prettier/prettier */
import {
  GATEWAY_PAYMENT_TYPES, GENERIC_GATEWAY_KEYS, PAYMENT_PROVIDER_CATALOG, gatewayChargeCurrency, inferGatewayMode, isThirdPartyGatewayType,
} from './payment-provider-catalog';
import { STORE_INTEGRATION_PROVIDERS } from './schemas/store-integration.schema';
import { gatewayKeysForCountry, paymentAvailability } from './payment-availability.util';

describe('payment provider catalog', () => {
  it('every catalog provider is a known StoreIntegration provider (so it can be stored)', () => {
    for (const key of Object.keys(PAYMENT_PROVIDER_CATALOG)) expect((STORE_INTEGRATION_PROVIDERS as readonly string[]).includes(key)).toBe(true);
  });

  it('every catalog-driven gateway asks for credentials, says how its webhook works and whether it can refund', () => {
    expect(GENERIC_GATEWAY_KEYS.sort()).toEqual(['flutterwave', 'mollie', 'paypal', 'paystack', 'razorpay', 'stripe_own']);
    for (const key of GENERIC_GATEWAY_KEYS) {
      const e = PAYMENT_PROVIDER_CATALOG[key];
      expect(e.fields.length).toBeGreaterThan(0);
      expect(e.fields.some((f) => f.secret)).toBe(true);
      expect(['none', 'secret', 'url']).toContain(e.webhook);
      if (e.webhook === 'secret') expect(e.webhookSecretLabel).toBeTruthy();
      if (e.webhook !== 'none') expect(e.webhookHelp).toBeTruthy();
      expect(['api', 'manual']).toContain(e.refunds);
    }
  });

  it('payment transaction/order types cover every gateway so none can fail the schema enum', () => {
    for (const key of ['safepay', 'jazzcash', 'easypaisa', 'payfast', 'stripe', ...GENERIC_GATEWAY_KEYS]) expect(GATEWAY_PAYMENT_TYPES).toContain(key);
  });

  it('a third-party gateway is anything the seller connects themselves — not Stripe Connect or bank transfer', () => {
    expect(isThirdPartyGatewayType('paypal')).toBe(true);
    expect(isThirdPartyGatewayType('safepay')).toBe(true);
    expect(isThirdPartyGatewayType('stripe')).toBe(false);
    expect(isThirdPartyGatewayType('bank_transfer')).toBe(false);
    expect(isThirdPartyGatewayType('cash_on_delivery')).toBe(false);
    expect(isThirdPartyGatewayType(undefined)).toBe(false);
  });

  it('only the gateways that really have a refund API are marked automatic', () => {
    expect(PAYMENT_PROVIDER_CATALOG.safepay.refunds).toBe('api');
    for (const k of ['payfast', 'jazzcash', 'easypaisa']) expect(PAYMENT_PROVIDER_CATALOG[k].refunds).toBe('manual');
    for (const k of GENERIC_GATEWAY_KEYS) expect(PAYMENT_PROVIDER_CATALOG[k].refunds).toBe('api');
  });
});

describe('gateway charge currency', () => {
  it('uses the store currency when the gateway takes it, else the gateway\'s own first currency', () => {
    expect(gatewayChargeCurrency('mollie', 'EUR')).toBe('EUR');
    expect(gatewayChargeCurrency('razorpay', 'USD')).toBe('INR');
    expect(gatewayChargeCurrency('paystack', 'ngn')).toBe('NGN');
    expect(gatewayChargeCurrency('safepay', 'USD')).toBe('PKR');
    expect(gatewayChargeCurrency('stripe_own', 'jpy')).toBe('JPY'); // any currency
    expect(gatewayChargeCurrency('stripe_own', null)).toBe('USD');
  });
});

describe('mode from the key', () => {
  it('reads sandbox/live from the key prefix when the provider encodes it', () => {
    expect(inferGatewayMode('stripe_own', { secretKey: 'sk_test_123' })).toBe('sandbox');
    expect(inferGatewayMode('stripe_own', { secretKey: 'rk_live_123' })).toBe('live');
    expect(inferGatewayMode('razorpay', { keyId: 'rzp_test_abc' })).toBe('sandbox');
    expect(inferGatewayMode('razorpay', { keyId: 'rzp_live_abc' })).toBe('live');
    expect(inferGatewayMode('paystack', { secretKey: 'sk_live_x' })).toBe('live');
    expect(inferGatewayMode('mollie', { apiKey: 'test_abc' })).toBe('sandbox');
    expect(inferGatewayMode('flutterwave', { secretKey: 'FLWSECK_TEST-abc' })).toBe('sandbox');
    expect(inferGatewayMode('flutterwave', { secretKey: 'FLWSECK-abc' })).toBe('live');
  });
  it('is unknown for providers that make the seller choose (PayPal) or unrecognised keys', () => {
    expect(inferGatewayMode('paypal', { clientId: 'x', clientSecret: 'y' })).toBeNull();
    expect(inferGatewayMode('mollie', { apiKey: 'weird' })).toBeNull();
  });
});

describe('which gateways a store country can connect', () => {
  it('Pakistan: local gateways + PayPal is NOT offered (PayPal cannot receive in Pakistan), nor Stripe own keys', () => {
    expect(gatewayKeysForCountry('PK')).toEqual(['safepay', 'payfast', 'jazzcash', 'easypaisa']);
    expect(paymentAvailability('paypal', 'PK').available).toBe(false);
    expect(paymentAvailability('stripe_own', 'PK').available).toBe(false);
  });
  it('United States: Stripe own keys + PayPal, no regional gateways', () => {
    expect(gatewayKeysForCountry('US')).toEqual(['stripe_own', 'paypal']);
  });
  it('India gets Razorpay, Nigeria gets Paystack + Flutterwave, Germany gets Mollie + Stripe + PayPal', () => {
    expect(gatewayKeysForCountry('IN')).toEqual(['paypal', 'razorpay']);
    expect(gatewayKeysForCountry('NG')).toEqual(['paypal', 'paystack', 'flutterwave']);
    expect(gatewayKeysForCountry('DE')).toEqual(['stripe_standard', 'stripe_own', 'paypal', 'mollie']);
  });
  it('Stripe\'s own account list excludes countries Stripe only serves in preview or through Paystack', () => {
    for (const c of ['IN', 'ID', 'NG', 'GH', 'KE', 'ZA', 'CI', 'PK']) expect(paymentAvailability('stripe_own', c).available).toBe(false);
    for (const c of ['US', 'GB', 'AE', 'SG', 'JP', 'BR']) expect(paymentAvailability('stripe_own', c).available).toBe(true);
  });
  it('Stripe Standard (zero-fee direct charges) is offered where the platform\'s own Connect is not, never beside it', () => {
    expect(paymentAvailability('stripe_standard', 'DE').available).toBe(true);
    expect(paymentAvailability('stripe_standard', 'AE').available).toBe(true);
    expect(paymentAvailability('stripe_standard', 'US').available).toBe(false); // US already has the main Stripe option
    expect(paymentAvailability('stripe_standard', 'US').reason).toMatch(/already available/);
    expect(paymentAvailability('stripe_standard', 'PK').available).toBe(false); // Stripe has no Pakistan
    expect(paymentAvailability('stripe_standard', 'NG').available).toBe(false); // served through Paystack
  });
  it('an unknown country offers nothing and asks the seller to set it', () => {
    expect(gatewayKeysForCountry(null)).toEqual([]);
    expect(paymentAvailability('mollie', null).reason).toMatch(/Set your store country/);
  });
  it('the reason names the provider and the country', () => {
    expect(paymentAvailability('razorpay', 'US').reason).toBe('Razorpay is not available for stores in United States.');
    expect(paymentAvailability('paypal', 'IR').reason).toMatch(/PayPal is not available for stores in/);
  });
});
