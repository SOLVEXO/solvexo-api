/* eslint-disable prettier/prettier */
import { SellerPlatformSubscriptionsService } from './seller-platform-subscriptions.service';

/**
 * Stripe webhook fixtures for the seller platform-plan billing handlers. The
 * same logical invoice event is fed in BOTH payload shapes (legacy
 * `invoice.subscription` and Basil+ `invoice.parent.subscription_details`) —
 * previously a Basil+ payload silently returned early ("not a subscription
 * invoice"), dropping every renewal and failure.
 */
describe('SellerPlatformSubscriptionsService — Stripe invoice webhooks (both API shapes)', () => {
  const PROVIDER_SUB_ID = 'sub_stripe_1';

  const legacyInvoice = (over: Record<string, any> = {}) => ({
    id: 'in_1', subscription: PROVIDER_SUB_ID, payment_intent: 'pi_1', billing_reason: 'subscription_cycle',
    amount_paid: 2900, amount_due: 2900, lines: { data: [{ period: { start: 1_700_000_000, end: 1_702_592_000 } }] },
    hosted_invoice_url: 'https://stripe.test/i/1', invoice_pdf: 'https://stripe.test/i/1.pdf', ...over,
  });

  const basilInvoice = (over: Record<string, any> = {}) => ({
    id: 'in_1', billing_reason: 'subscription_cycle', amount_paid: 2900, amount_due: 2900,
    parent: { type: 'subscription_details', subscription_details: { subscription: PROVIDER_SUB_ID } },
    lines: { data: [{ period: { start: 1_700_000_000, end: 1_702_592_000 } }] },
    hosted_invoice_url: 'https://stripe.test/i/1', invoice_pdf: 'https://stripe.test/i/1.pdf', ...over,
  });

  let service: SellerPlatformSubscriptionsService;
  let subModel: any;
  let invoiceModel: any;
  let sub: any;

  function setup() {
    sub = {
      _id: 'local-sub-1', storeId: 'store-1', sellerId: 'seller-1', platformPlanId: 'plan-1',
      status: 'past_due', billingInterval: 'monthly', totalPaidUSD: 0, failedPaymentAttempts: 0,
      lastFailedStripeInvoiceId: null, save: jest.fn().mockResolvedValue(undefined),
      toString() { return 'local-sub-1'; },
    };
    subModel = {
      findOne: jest.fn().mockImplementation((filter: any) =>
        Promise.resolve(filter.providerSubscriptionId === PROVIDER_SUB_ID ? sub : null)),
    };
    invoiceModel = { exists: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue([{}]), deleteOne: jest.fn().mockResolvedValue({}) };
    const planQuery = (doc: any) => { const q: any = { select: () => q, lean: () => Promise.resolve(doc) }; return q; };
    const planModel = { findById: jest.fn().mockImplementation((id: string) => planQuery({ _id: id, name: id === 'plan-2' ? 'Grow' : 'Basic' })) };

    const db = { repositories: { sellerPlatformSubscriptionModel: subModel, platformPlanInvoiceModel: invoiceModel, platformPlanModel: planModel } } as any;
    service = new SellerPlatformSubscriptionsService(
      db, {} as any, { log: jest.fn() } as any, {} as any, {} as any, {} as any, { transaction: jest.fn((fn: any) => fn({})) } as any,
    );

    jest.spyOn(service as any, 'generateInvoiceNumber').mockResolvedValue('INV-0001');
    jest.spyOn(service as any, 'withTransaction').mockImplementation((fn: any) => fn({}));
    jest.spyOn(service as any, 'unlockStorefrontIfComingSoon').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'syncFeaturedBadge').mockResolvedValue(undefined);
  }

  beforeEach(setup);

  describe.each([
    ['legacy (pre-Basil)', legacyInvoice],
    ['Basil+', basilInvoice],
  ])('invoice.payment_succeeded — %s payload', (_name, make) => {
    it('records the paid invoice and reactivates the subscription', async () => {
      await service.handleInvoicePaymentSucceeded(make());

      expect(invoiceModel.create).toHaveBeenCalledTimes(1);
      const [[doc]] = invoiceModel.create.mock.calls[0];
      expect(doc).toEqual(expect.objectContaining({
        storeId: 'store-1', sellerId: 'seller-1', amountUSD: 29, status: 'paid', stripeInvoiceId: 'in_1', type: 'recurring',
      }));
      expect(sub.status).toBe('active');
      expect(sub.totalPaidUSD).toBe(29);
      expect(sub.failedPaymentAttempts).toBe(0);
      expect(sub.currentPeriodEnd).toEqual(new Date(1_702_592_000 * 1000));
      expect(sub.save).toHaveBeenCalled();
    });

    it('is idempotent — a redelivered event for an already-recorded invoice changes nothing', async () => {
      invoiceModel.exists.mockResolvedValue({ _id: 'existing' });
      await service.handleInvoicePaymentSucceeded(make());
      expect(invoiceModel.create).not.toHaveBeenCalled();
      expect(sub.save).not.toHaveBeenCalled();
    });

    it('ignores an invoice for a Stripe subscription that is not ours', async () => {
      const foreign = make();
      if ('subscription' in foreign) foreign.subscription = 'sub_someone_else';
      else foreign.parent.subscription_details.subscription = 'sub_someone_else';
      await service.handleInvoicePaymentSucceeded(foreign);
      expect(invoiceModel.create).not.toHaveBeenCalled();
    });
  });

  it('REGRESSION: a Basil+ invoice is NOT dropped as "not a subscription invoice" (the original silent-failure mode)', async () => {
    await service.handleInvoicePaymentSucceeded(basilInvoice());
    expect(subModel.findOne).toHaveBeenCalledWith(expect.objectContaining({ providerSubscriptionId: PROVIDER_SUB_ID }));
    expect(invoiceModel.create).toHaveBeenCalled();
  });

  it('ignores a one-off (non-subscription) invoice', async () => {
    await service.handleInvoicePaymentSucceeded({ id: 'in_x', subscription: null, parent: null, amount_paid: 500 });
    expect(subModel.findOne).not.toHaveBeenCalled();
    expect(invoiceModel.create).not.toHaveBeenCalled();
  });

  describe.each([
    ['legacy (pre-Basil)', legacyInvoice],
    ['Basil+', basilInvoice],
  ])('invoice.payment_failed — %s payload', (_name, make) => {
    it('counts one dunning attempt and remembers the failed invoice id', async () => {
      const dunning = jest.spyOn(service as any, 'applyDunningFailure').mockResolvedValue(undefined);

      await service.handleInvoicePaymentFailed(make());

      // The third argument is Stripe's own next retry time (none in these fixtures).
      expect(dunning).toHaveBeenCalledWith(sub, 29, null);
      expect(sub.lastFailedStripeInvoiceId).toBe('in_1');
      expect(sub.save).toHaveBeenCalled();
    });

    it('does not double-count Stripe Smart Retries for the same invoice', async () => {
      sub.lastFailedStripeInvoiceId = 'in_1';
      const dunning = jest.spyOn(service as any, 'applyDunningFailure').mockResolvedValue(undefined);

      await service.handleInvoicePaymentFailed(make());

      expect(dunning).not.toHaveBeenCalled();
    });
  });

  describe('a paid first purchase whose webhook did not apply it', () => {
    const GROW = 'plan-2';
    let gateway: any;
    let created: string[];

    beforeEach(() => {
      sub.status = 'trial_ended';
      sub.providerSubscriptionId = PROVIDER_SUB_ID;
      sub.pendingPlanChange = { kind: 'first_purchase', planId: GROW, interval: 'monthly', amountUSD: 28.66, stripeSubscriptionId: PROVIDER_SUB_ID, createdAt: new Date(Date.now() - 5 * 60_000) };
      created = [];
      invoiceModel.exists.mockImplementation((f: any) => Promise.resolve(created.includes(f.stripeInvoiceId) ? { _id: 'x' } : null));
      invoiceModel.create.mockImplementation(async ([doc]: any[]) => { await new Promise((r) => setTimeout(r, 5)); created.push(doc.stripeInvoiceId); return [doc]; });
      subModel.findOne = jest.fn().mockImplementation((f: any) => Promise.resolve(f.providerSubscriptionId === PROVIDER_SUB_ID || f.storeId === 'store-1' ? sub : null));
      subModel.findById = jest.fn().mockImplementation(() => { const p: any = Promise.resolve(sub); p.lean = () => Promise.resolve(sub); return p; });
      gateway = { getLatestSubscriptionInvoice: jest.fn().mockResolvedValue(legacyInvoice({ status: 'paid', billing_reason: 'subscription_create', amount_paid: 100 })) };
      (service as any).gateway = gateway;
      jest.spyOn(service, 'verifyStoreOwnership').mockResolvedValue(undefined as any);
    });

    it('confirming checks Stripe and applies the paid plan at once, without waiting for the webhook', async () => {
      const r: any = await service.confirmPendingPlanChange('seller-1', 'store-1');
      expect(gateway.getLatestSubscriptionInvoice).toHaveBeenCalledWith(PROVIDER_SUB_ID, 'local-sub-1');
      expect(r.data).toMatchObject({ pending: false, applied: true });
      expect(sub.platformPlanId).toBe(GROW);
      expect(sub.pendingPlanChange).toBeNull();
      expect(sub.status).toBe('active');
      expect(invoiceModel.create).toHaveBeenCalledTimes(1);
      expect(invoiceModel.create.mock.calls[0][0][0]).toMatchObject({ type: 'initial', status: 'paid', stripeInvoiceId: 'in_1', platformPlanId: GROW });
    });

    it('applies nothing while Stripe has not been paid', async () => {
      gateway.getLatestSubscriptionInvoice.mockResolvedValue(legacyInvoice({ status: 'open', amount_paid: 0 }));
      const r: any = await service.confirmPendingPlanChange('seller-1', 'store-1');
      expect(r.data).toMatchObject({ pending: true, applied: false });
      expect(sub.platformPlanId).toBe('plan-1');
      expect(invoiceModel.create).not.toHaveBeenCalled();
    });

    it('records the payment once when the webhook and the direct check arrive together', async () => {
      const inv = legacyInvoice({ status: 'paid', billing_reason: 'subscription_create', amount_paid: 100 });
      await Promise.all([service.handleInvoicePaymentSucceeded(inv), service.confirmPendingPlanChange('seller-1', 'store-1')]);
      expect(invoiceModel.create).toHaveBeenCalledTimes(1);
      expect(sub.platformPlanId).toBe(GROW);
    });

    it('the safety-net job applies paid purchases still pending after two minutes', async () => {
      subModel.find = jest.fn().mockReturnValue({ limit: () => Promise.resolve([sub]) });
      const r = await service.reconcilePendingPurchases();
      expect(subModel.find).toHaveBeenCalledWith(expect.objectContaining({ 'pendingPlanChange.kind': { $in: ['first_purchase', 'trial_conversion'] } }));
      expect(r).toEqual({ checked: 1, applied: 1 });
      expect(sub.platformPlanId).toBe(GROW);
    });

    it('never treats a trial commitment as paid before the trial-end charge', async () => {
      sub.pendingPlanChange = { ...sub.pendingPlanChange, kind: 'trial_conversion' };
      gateway.getLatestSubscriptionInvoice.mockResolvedValue(legacyInvoice({ status: 'paid', amount_paid: 0 }));
      const r: any = await service.confirmPendingPlanChange('seller-1', 'store-1');
      expect(r.data.applied).toBe(false);
      expect(invoiceModel.create).not.toHaveBeenCalled();
    });

    it('ignores a Stripe subscription that is not ours (metadata mismatch returns no invoice)', async () => {
      gateway.getLatestSubscriptionInvoice.mockResolvedValue(null);
      const r: any = await service.confirmPendingPlanChange('seller-1', 'store-1');
      expect(r.data.applied).toBe(false);
    });
  });
});
