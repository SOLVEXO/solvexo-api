/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { StripeStandardPaymentProvider } from './providers/stripe-standard.provider';
import { StripeOwnPaymentProvider } from './providers/stripe-own.provider';
import { StoreIntegrationsService } from './store-integrations.service';
import { DatabaseService } from '../database/databaseservice';
import { classifyPaymentRail } from '../commission-rules/payment-rail';

const ACCOUNT = 'acct_123';
const cfg = (extra: any = {}) => ({ credentials: {}, config: { accountId: ACCOUNT }, mode: 'sandbox' as const, webhookToken: 'wt', ...extra });

describe('StripeStandardPaymentProvider (direct charges on the seller\'s own account)', () => {
  const realFetch = global.fetch;
  let calls: { url: string; init: any }[];
  const provider = (key: string | undefined = 'sk_test_platform') =>
    new StripeStandardPaymentProvider(new StripeOwnPaymentProvider(), { get: () => key } as any);

  beforeEach(() => {
    calls = [];
    (global as any).fetch = async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      const body = String(url).includes('/checkout/sessions/')
        ? { id: 'cs_1', payment_status: 'paid', status: 'complete', amount_total: 5000, currency: 'eur', payment_intent: { id: 'pi_1' } }
        : String(url).includes('/checkout/sessions') ? { id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' }
        : String(url).includes('/refunds') ? { id: 're_1', status: 'succeeded' }
        : String(url).includes('/payment_intents/') ? { id: 'pi_1', currency: 'eur' }
        : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    };
  });
  afterEach(() => { (global as any).fetch = realFetch; });

  it('creates the Checkout Session ON the seller\'s account with the platform key and NO application fee', async () => {
    const session = await provider().initiatePayment(
      { orderId: 'chk1', amount: 50, currency: 'EUR', storeId: 's1', returnUrl: 'https://shop.example/return', cancelUrl: 'https://shop.example/cart' } as any, cfg(),
    );
    expect(session).toEqual({ redirectUrl: 'https://checkout.stripe.com/c/cs_1', sessionId: 'cs_1' });
    const h = calls[0].init.headers;
    expect(h.Authorization).toBe('Bearer sk_test_platform');
    expect(h['Stripe-Account']).toBe(ACCOUNT);
    expect(String(calls[0].init.body)).not.toContain('application_fee');
  });

  it('verifies on the same connected account and reports the amount for the shared checks', async () => {
    const st = await provider().verifyPayment('cs_1', cfg());
    expect(st).toMatchObject({ status: 'paid', amount: 50, currency: 'EUR', paymentId: 'pi_1' });
    expect(calls[0].init.headers['Stripe-Account']).toBe(ACCOUNT);
  });

  it('refunds on the connected account too', async () => {
    const r = await provider().refund('pi_1', 20, cfg());
    expect(r.success).toBe(true);
    expect(calls.every((c) => c.init.headers['Stripe-Account'] === ACCOUNT)).toBe(true);
  });

  it('refuses to work for a seller who has not connected an account, or without the platform key', async () => {
    await expect(provider().initiatePayment({} as any, cfg({ config: {} }))).rejects.toThrow('has not connected a Stripe account');
    await expect(provider('').verifyPayment('cs_1', cfg())).rejects.toThrow('not configured on the platform');
    expect((await provider().testConnection(cfg({ config: {} }))).ok).toBe(false);
    expect((await provider().refund('pi', 5, cfg({ config: {} }))).success).toBe(false);
  });

  it('has no webhook of its own (the platform Connect webhook handles connected-account events)', async () => {
    await expect(provider().handleWebhook()).rejects.toThrow('platform Stripe webhook');
  });
});

describe('Stripe Standard is a fee-free direct-settled rail', () => {
  it('is classified like COD / bank transfer: no plan fee, never platform-held', () => {
    expect(classifyPaymentRail('stripe_standard')).toBe('manual');
    expect(classifyPaymentRail('stripe')).toBe('solvexo_card');
    expect(classifyPaymentRail('paypal')).toBe('third_party');
  });
});

describe('StoreIntegrationsService — Stripe Standard onboarding', () => {
  const STORE = 'store-1', SELLER = 'seller-1';
  function build(store: any = {}, existing: any = null, account: any = { chargesEnabled: true, detailsSubmitted: true }) {
    const storeRow = { _id: STORE, sellerId: SELLER, isDelete: false, baseCurrency: 'EUR', country: 'DE', ...store };
    const storeIntegrationModel: any = {
      findOne: jest.fn().mockResolvedValue(existing),
      findOneAndUpdate: jest.fn().mockImplementation((_f: any, u: any) => Promise.resolve({ _id: 'int-1', type: 'payment', provider: 'stripe_standard', ...(u.$set ?? {}), config: { accountId: 'acct_new' }, webhookToken: 'wt' })),
    };
    const repos = { storeModel: { findById: jest.fn().mockResolvedValue(storeRow) }, storeIntegrationModel, sellerModel: { findById: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ email: 's@x.com' }) }) }) } };
    const stripeConnect: any = {
      isTestMode: jest.fn().mockReturnValue(true),
      createStandardAccount: jest.fn().mockResolvedValue('acct_new'),
      createAccountOnboardingUrl: jest.fn().mockResolvedValue('https://connect.stripe.com/setup/x'),
      retrieveAccountState: jest.fn().mockResolvedValue(account),
    };
    const service = new StoreIntegrationsService({ repositories: repos } as unknown as DatabaseService, { log: jest.fn() } as any, {} as any, {} as any, stripeConnect, {} as any, {} as any);
    return { service, stripeConnect, storeIntegrationModel };
  }

  it('creates the seller\'s own Standard account in the STORE country once and returns Stripe\'s onboarding URL', async () => {
    const { service, stripeConnect, storeIntegrationModel } = build();
    const res: any = await service.startStripeStandard(STORE, SELLER, 'https://x/refresh', 'https://x/return');
    expect(res.data.url).toBe('https://connect.stripe.com/setup/x');
    expect(stripeConnect.createStandardAccount).toHaveBeenCalledWith('DE', 's@x.com', STORE);
    const set = storeIntegrationModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set).toMatchObject({ status: 'error', lastError: 'Stripe onboarding incomplete', 'config.accountId': 'acct_new', 'config.currency': 'EUR' });
  });

  it('reuses the account on a second start (no second account is created)', async () => {
    const { service, stripeConnect } = build({}, { config: { accountId: 'acct_old' } });
    await service.startStripeStandard(STORE, SELLER, 'https://x/r', 'https://x/b');
    expect(stripeConnect.createStandardAccount).not.toHaveBeenCalled();
    expect(stripeConnect.createAccountOnboardingUrl).toHaveBeenCalledWith('acct_old', 'https://x/r', 'https://x/b');
  });

  it('REGRESSION: refused where the platform Connect already serves the country (US) or Stripe has no accounts (Pakistan)', async () => {
    await expect(build({ country: 'US', baseCurrency: 'USD' }).service.startStripeStandard(STORE, SELLER, 'a', 'b')).rejects.toBeInstanceOf(BadRequestException);
    await expect(build({ country: 'PK', baseCurrency: 'PKR' }).service.startStripeStandard(STORE, SELLER, 'a', 'b')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sync: connected only when Stripe reports charges enabled AND details submitted; otherwise stays incomplete and off at checkout', async () => {
    const ok = build({}, { _id: 'int-1', config: { accountId: 'acct_1' } }, { chargesEnabled: true, detailsSubmitted: true });
    await ok.service.syncStripeStandard(STORE, SELLER);
    expect(ok.storeIntegrationModel.findOneAndUpdate.mock.calls[0][1].$set).toMatchObject({ status: 'connected', lastError: null });

    const pending = build({}, { _id: 'int-1', config: { accountId: 'acct_1' } }, { chargesEnabled: false, detailsSubmitted: true });
    await pending.service.syncStripeStandard(STORE, SELLER);
    expect(pending.storeIntegrationModel.findOneAndUpdate.mock.calls[0][1].$set).toMatchObject({ status: 'error', isEnabledForCheckout: false });
  });

  it('sync without starting first, and the generic connect call, are refused with a clear message', async () => {
    const { service } = build({}, null);
    await expect(service.syncStripeStandard(STORE, SELLER)).rejects.toThrow('Start the Stripe connection first');
    await expect(service.connect(STORE, SELLER, 'payment', 'stripe_standard' as any, {})).rejects.toThrow('Stripe\'s own onboarding');
  });
});
