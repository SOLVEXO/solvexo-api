/* eslint-disable prettier/prettier */

// Capture how the provider constructs its Stripe client and stub the
// subscriptions API, so we assert the API-version pin and the client_secret
// extraction without any network call.
const stripeCtor = jest.fn();
const subscriptionsCreate = jest.fn();
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((...args: any[]) => {
    stripeCtor(...args);
    return { subscriptions: { create: subscriptionsCreate } };
  }),
}));

import { StripePaymentProvider } from './stripe-payment.provider';

describe('StripePaymentProvider', () => {
  beforeEach(() => {
    stripeCtor.mockClear();
    subscriptionsCreate.mockReset();
  });

  it('REGRESSION: pins the Stripe API version to the last pre-Basil release (never the SDK default)', () => {
    new StripePaymentProvider('sk_test_123');
    const [key, opts] = stripeCtor.mock.calls[0];
    expect(key).toBe('sk_test_123');
    expect(opts.apiVersion).toBe('2025-02-24.acacia');
  });

  describe('createProviderSubscription', () => {
    const context = { providerCustomerId: 'cus_1', providerPriceId: 'price_1' } as any;

    it('expands latest_invoice.payment_intent and returns its client_secret (pre-Basil shape)', async () => {
      subscriptionsCreate.mockResolvedValue({
        id: 'sub_1', status: 'incomplete',
        latest_invoice: { id: 'in_1', payment_intent: { id: 'pi_1', client_secret: 'pi_1_secret_abc' } },
      });

      const res = await new StripePaymentProvider('sk').createProviderSubscription('local-sub-1', 'Pro', 29, 'monthly', context);

      expect(subscriptionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_1', payment_behavior: 'default_incomplete', expand: ['latest_invoice.payment_intent'] }),
        expect.objectContaining({ idempotencyKey: 'sub_create_local-sub-1' }),
      );
      expect(res).toEqual({ providerSubscriptionId: 'sub_1', clientSecret: 'pi_1_secret_abc', status: 'incomplete' });
    });

    it('also accepts the Basil+ invoice.confirmation_secret shape if the pin is ever raised', async () => {
      subscriptionsCreate.mockResolvedValue({
        id: 'sub_2', status: 'incomplete',
        latest_invoice: { id: 'in_2', confirmation_secret: { client_secret: 'conf_secret_xyz' } },
      });

      const res = await new StripePaymentProvider('sk').createProviderSubscription('local-sub-2', 'Pro', 29, 'monthly', context);
      expect(res.clientSecret).toBe('conf_secret_xyz');
    });

    it('returns an undefined clientSecret (no throw) for a trial subscription with no payable invoice', async () => {
      subscriptionsCreate.mockResolvedValue({ id: 'sub_3', status: 'trialing', latest_invoice: null });
      const res = await new StripePaymentProvider('sk').createProviderSubscription('local-sub-3', 'Pro', 29, 'monthly', context);
      expect(res).toEqual({ providerSubscriptionId: 'sub_3', clientSecret: undefined, status: 'trialing' });
    });

    it('requires a Stripe customer and price id', async () => {
      const p = new StripePaymentProvider('sk');
      await expect(p.createProviderSubscription('s', 'n', 1, 'monthly', { providerPriceId: 'p' } as any)).rejects.toThrow('providerCustomerId');
      await expect(p.createProviderSubscription('s', 'n', 1, 'monthly', { providerCustomerId: 'c' } as any)).rejects.toThrow('providerPriceId');
    });
  });
});
