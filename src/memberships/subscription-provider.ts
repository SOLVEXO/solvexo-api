import { NotImplementedException } from '@nestjs/common';

/**
 * Billing adapter behind MemberSubscription. The buyer's money always goes to the SELLER's own
 * gateway; Solvexo never holds it. Only MANUAL is implemented (the seller marks each period paid).
 * Stripe Connect and Safepay are declared here so the engine is provider-agnostic, but they are
 * NOT IMPLEMENTED: no adapter code, no credentials, nothing is faked.
 */
export interface SubscriptionProvider {
  readonly name: 'manual' | 'stripe' | 'safepay';
  readonly implemented: boolean;
  /** Ask the provider to stop future charges. Manual: nothing to do. */
  cancel(providerSubscriptionId: string | null): Promise<void>;
}

const manual: SubscriptionProvider = { name: 'manual', implemented: true, cancel: async () => undefined };

const notImplemented = (name: 'stripe' | 'safepay'): SubscriptionProvider => ({
  name,
  implemented: false,
  cancel: async () => {
    throw new NotImplementedException(`${name} subscriptions are not implemented`);
  },
});

export const SUBSCRIPTION_PROVIDERS: Record<string, SubscriptionProvider> = {
  manual,
  stripe: notImplemented('stripe'),
  safepay: notImplemented('safepay'),
};
