/* eslint-disable prettier/prettier */
/**
 * G5.4 — CARD GATEWAY (pending decision: no provider chosen). The till never talks to a card provider directly: a future adapter implements this
 * interface, behind the per-store flag `connectors.cardGateway` (OFF by default). Until a provider is chosen and its contract is in hand, only the MOCK
 * (dev + tests) exists, and every named real adapter throws "not configured". Nothing here guesses a provider's fields or endpoints.
 */
export interface CardChargeInput { storeId: string; amountMinor: number; currency: string; currencyExponent: number; reference: string }
export interface CardChargeResult { status: 'approved' | 'declined' | 'pending'; providerRef: string; approvalCode: string | null; last4: string | null; message?: string }
export interface CardGatewayProvider {
  readonly key: string;
  readonly testMode: boolean;
  charge(input: CardChargeInput): Promise<CardChargeResult>;
  refund(providerRef: string, amountMinor: number): Promise<{ status: 'refunded' | 'pending' | 'failed'; refundRef: string }>;
}

export class CardGatewayNotConfiguredError extends Error {
  constructor(readonly key: string, readonly needs: string[]) { super(`Card gateway "${key}" is not configured`); }
}

/** Dev / tests only: approves everything under 1,000,000 minor units, declines above; deterministic references. */
export class MockCardGateway implements CardGatewayProvider {
  readonly key = 'mock';
  readonly testMode = true;
  private n = 0;
  async charge(i: CardChargeInput): Promise<CardChargeResult> {
    this.n++;
    if (i.amountMinor >= 1_000_000) return { status: 'declined', providerRef: `mock_card_${this.n}`, approvalCode: null, last4: '0002', message: 'Declined by the mock gateway' };
    return { status: 'approved', providerRef: `mock_card_${this.n}`, approvalCode: String(100000 + this.n), last4: '4242' };
  }
  async refund(providerRef: string) { return { status: 'refunded' as const, refundRef: `${providerRef}_r` }; }
}

/**
 * Typed TODO adapters. Each lists exactly what it needs before it can be written; until then it throws `CardGatewayNotConfiguredError`.
 * (Which provider(s) to support is a business decision — see docs/pos-blueprint/G5_CLOSEOUT.md "TO ADD LATER".)
 */
export const CARD_GATEWAY_NEEDS: Record<string, string[]> = {
  provider_tbd: [
    'Decision: which card acquirer / gateway (e.g. the store\'s bank, or a payment facilitator) — from Sir Atiq',
    'The provider\'s API contract (charge, refund, status, webhook signature) and its sandbox credentials',
    'Card-present terminal integration method (SDK / cloud API / semi-integrated) and certification steps',
    'Merchant onboarding: merchant ID / terminal IDs per store (KYB link)',
  ],
};
export class NotConfiguredCardGateway implements CardGatewayProvider {
  readonly testMode = false;
  constructor(readonly key: string) {}
  async charge(): Promise<CardChargeResult> { throw new CardGatewayNotConfiguredError(this.key, CARD_GATEWAY_NEEDS[this.key] ?? CARD_GATEWAY_NEEDS.provider_tbd); }
  async refund(): Promise<{ status: 'refunded' | 'pending' | 'failed'; refundRef: string }> { throw new CardGatewayNotConfiguredError(this.key, CARD_GATEWAY_NEEDS[this.key] ?? CARD_GATEWAY_NEEDS.provider_tbd); }
}

/** The registry: the mock outside production; `CARD_GATEWAY_PROVIDER` names a real one later (today it resolves to the not-configured adapter). */
export function cardGatewayFor(env: NodeJS.ProcessEnv = process.env): CardGatewayProvider | null {
  const key = (env.CARD_GATEWAY_PROVIDER || (env.NODE_ENV === 'production' ? '' : 'mock')).toLowerCase();
  if (!key) return null;
  return key === 'mock' && env.NODE_ENV !== 'production' ? new MockCardGateway() : new NotConfiguredCardGateway(key);
}
