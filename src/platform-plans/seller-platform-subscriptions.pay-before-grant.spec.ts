/* eslint-disable prettier/prettier */
import { ForbiddenException } from '@nestjs/common';
import { SellerPlatformSubscriptionsService, PAST_DUE_LOCK_DAYS } from './seller-platform-subscriptions.service';
import { EntitlementsService } from './entitlements.service';

jest.mock('./stripe-customer.util', () => ({
  ensureSellerCustomerId: jest.fn().mockResolvedValue('cus_1'),
  resolveSubCustomerId: jest.fn().mockResolvedValue('cus_1'),
}));

/**
 * "A plan is NEVER granted before payment succeeds" — first purchase, failed/abandoned payment, 3DS upgrade,
 * proration credit rule, past-due lock for all stores, canceled limits, payment-received notification.
 */
describe('SellerPlatformSubscriptionsService — pay before grant', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = new Date('2026-11-20T00:00:00Z');
  const PROVIDER_SUB = 'sub_stripe_1';
  const leanOf = (v: any) => ({ lean: jest.fn().mockResolvedValue(v) });
  const selectLeanOf = (v: any) => ({ select: jest.fn(() => leanOf(v)) });

  const GROW = { _id: 'plan-grow', name: 'Grow', isFree: false, status: 'active', monthlyPriceUSD: 29, yearlyPriceUSD: 290, stripeMonthlyPriceId: 'price_m', stripeYearlyPriceId: 'price_y', limits: {} };
  const PRO = { _id: 'plan-pro', name: 'Pro', isFree: false, status: 'active', monthlyPriceUSD: 79, yearlyPriceUSD: 790, stripeMonthlyPriceId: 'price_pm', stripeYearlyPriceId: 'price_py', limits: {} };
  const FREE = { _id: 'plan-free', name: 'Free', isFree: true, status: 'active', limits: {} };

  function makeSub(over: Record<string, any> = {}): any {
    return {
      _id: 'local-sub-1', storeId: 'store-1', sellerId: 'seller-1', platformPlanId: null, amountUSD: 0,
      billingInterval: 'monthly', status: 'trialing', trialEndsAt: new Date(NOW.getTime() + 2 * DAY),
      currentPeriodStart: new Date(NOW.getTime() - DAY), currentPeriodEnd: new Date(NOW.getTime() + 2 * DAY),
      nextBillingDate: new Date(NOW.getTime() + 2 * DAY), totalPaidUSD: 0, failedPaymentAttempts: 0, creditBalanceUSD: 0,
      planHistory: [], pendingPlanChange: null, providerSubscriptionId: null, stripeCustomerId: null, paymentProvider: 'manual',
      legacyFreeEligible: false, lastFailedStripeInvoiceId: null,
      save: jest.fn().mockResolvedValue(undefined), markModified: jest.fn(),
      ...over,
    };
  }

  function make(sub: any, gatewayOver: Record<string, any> = {}, planFindOne?: (q: any) => any) {
    const plans: Record<string, any> = { [GROW._id]: GROW, [PRO._id]: PRO, [FREE._id]: FREE };
    const subModel = {
      findOne: jest.fn().mockImplementation((f: any) => Promise.resolve(f?.providerSubscriptionId ? (f.providerSubscriptionId === sub.providerSubscriptionId ? sub : null) : sub)),
      find: jest.fn().mockResolvedValue([sub]), updateOne: jest.fn().mockResolvedValue({}),
    };
    const planModel = {
      findById: jest.fn((id: string) => {
        const doc = plans[id] ? { ...plans[id], save: jest.fn() } : null;
        return Object.assign(Promise.resolve(doc), { lean: jest.fn().mockResolvedValue(plans[id] ?? null), select: jest.fn(() => leanOf(plans[id] ?? null)) });
      }),
      findOne: jest.fn((q: any) => {
        if (planFindOne) return Promise.resolve(planFindOne(q));
        if (q?.isFree) return Promise.resolve(FREE);
        return Promise.resolve(q?._id && plans[q._id] ? { ...plans[q._id], save: jest.fn() } : null);
      }),
    };
    const invoiceModel = { exists: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue([{ _id: 'inv1' }]), deleteOne: jest.fn() };
    const storeModel = {
      findById: jest.fn().mockImplementation(() => Object.assign(Promise.resolve({ sellerId: 'seller-1', isDelete: false, badges: [] }), selectLeanOf({ name: 'Shop' }))),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    const sellerModel = { findById: jest.fn(() => Object.assign(Promise.resolve({ _id: 'seller-1', stripeCustomerId: 'cus_1' }), selectLeanOf({ name: 'Sam', email: 'sam@test.com' }))) };
    const gateway: any = {
      isProviderDrivenBilling: true,
      createProviderSubscription: jest.fn().mockResolvedValue({ providerSubscriptionId: PROVIDER_SUB, clientSecret: 'pi_secret', status: 'incomplete' }),
      cancelProviderSubscription: jest.fn().mockResolvedValue(undefined),
      chargeSubscription: jest.fn(), updateProviderSubscriptionPrice: jest.fn().mockResolvedValue(undefined),
      ...gatewayOver,
    };
    const notifications: any = {
      sendPaymentReceived: jest.fn().mockResolvedValue(undefined), sendStoreLocked: jest.fn().mockResolvedValue(undefined),
      sendDowngradedDueToFailedPayments: jest.fn().mockResolvedValue(undefined), sendPaymentFailed: jest.fn().mockResolvedValue(undefined),
      sendPlanUpgraded: jest.fn().mockResolvedValue(undefined),
    };
    const notificationsService: any = { notify: jest.fn(() => Promise.resolve()), notifyAdmins: jest.fn(() => Promise.resolve()) };
    const criticalAlerts: any = { send: jest.fn().mockResolvedValue(undefined) };
    const db: any = { repositories: {
      sellerPlatformSubscriptionModel: subModel, platformPlanModel: planModel, platformPlanInvoiceModel: invoiceModel,
      platformPlanPaymentAttemptModel: { countDocuments: jest.fn().mockResolvedValue(0), create: jest.fn() },
      storeModel, sellerModel,
      adminModel: { findById: jest.fn(() => ({ select: () => ({ lean: () => ({ catch: () => Promise.resolve({ name: 'Admin Amy' }) }) }) })) },
    } };
    const service: any = new (SellerPlatformSubscriptionsService as any)(
      db, gateway, { log: jest.fn() }, notifications, notificationsService, criticalAlerts, { transaction: jest.fn((fn: any) => fn({})) },
    );
    jest.spyOn(service, 'generateInvoiceNumber').mockResolvedValue('INV-1');
    jest.spyOn(service, 'withTransaction').mockImplementation((fn: any) => fn({}));
    jest.spyOn(service, 'unlockStorefrontIfComingSoon').mockResolvedValue(undefined);
    jest.spyOn(service, 'syncFeaturedBadge').mockResolvedValue(undefined);
    jest.spyOn(service, 'getSellerAndStoreNames').mockResolvedValue({ sellerName: 'Sam', sellerEmail: 'sam@test.com', billingRecipients: ['sam@test.com'], storeName: 'Shop' });
    return { service, subModel, gateway, notifications, notificationsService, criticalAlerts, invoiceModel, storeModel };
  }

  const flush = () => new Promise((r) => setImmediate(r));
  const paidInvoice = (over: any = {}) => ({
    id: 'in_1', subscription: PROVIDER_SUB, billing_reason: 'subscription_create', amount_paid: 2900, amount_due: 2900,
    lines: { data: [{ period: { end: 1_800_000_000 } }] }, hosted_invoice_url: 'https://stripe.test/i/1', ...over,
  });
  const pendingOf = (kind: any, extra: any = {}) => ({
    kind, planId: GROW._id, interval: 'monthly', amountUSD: 29, stripeSubscriptionId: PROVIDER_SUB, createdAt: NOW, ...extra,
  });

  // ── first purchase: nothing granted until paid ───────────────────────────
  describe('changePlan — first paid purchase', () => {
    it.each(['trial_ended', 'locked', 'trialing'])('from %s: stores a pending change and leaves plan/status/limits untouched, returns the clientSecret', async (status) => {
      const sub = makeSub({ status, trialEndsAt: status === 'trialing' ? new Date(NOW.getTime() + 2 * DAY) : new Date(NOW.getTime() - DAY) });
      const { service, gateway } = make(sub);
      jest.spyOn(service, 'verifyStoreOwnership').mockResolvedValue({});
      const res: any = await service.changePlan('seller-1', 'store-1', { platformPlanId: GROW._id, billingInterval: 'monthly', billImmediately: true });

      expect(gateway.createProviderSubscription).toHaveBeenCalled();
      expect(sub.platformPlanId).toBeNull();
      expect(sub.amountUSD).toBe(0);
      expect(sub.status).toBe(status);
      expect(sub.planHistory).toEqual([]);
      expect(sub.pendingPlanChange).toMatchObject({ kind: 'first_purchase', planId: GROW._id, stripeSubscriptionId: PROVIDER_SUB });
      expect(res.data.requiresAction).toBe(true);
      expect(res.data.clientSecret).toBe('pi_secret');
    });

    it('a retry after an abandoned attempt cancels the dead Stripe sub and never takes the ad-hoc charge path', async () => {
      const sub = makeSub({ status: 'trial_ended', trialEndsAt: new Date(NOW.getTime() - DAY), providerSubscriptionId: 'sub_dead', stripeCustomerId: 'cus_1', paymentProvider: 'stripe',
        pendingPlanChange: pendingOf('first_purchase', { stripeSubscriptionId: 'sub_dead' }) });
      const { service, gateway } = make(sub);
      jest.spyOn(service, 'verifyStoreOwnership').mockResolvedValue({});
      await service.changePlan('seller-1', 'store-1', { platformPlanId: GROW._id, billingInterval: 'monthly', billImmediately: true });

      expect(gateway.cancelProviderSubscription).toHaveBeenCalledWith('sub_dead');
      expect(gateway.chargeSubscription).not.toHaveBeenCalled();
      expect(sub.providerSubscriptionId).toBe(PROVIDER_SUB);
      expect(sub.pendingPlanChange.stripeSubscriptionId).toBe(PROVIDER_SUB);
    });

    it('wrong seller / store still gets 403', async () => {
      const { service } = make(makeSub());
      await expect(service.changePlan('someone-else', 'store-1', { platformPlanId: GROW._id, billingInterval: 'monthly' })).rejects.toThrow(ForbiddenException);
      await expect(service.confirmPendingPlanChange('someone-else', 'store-1')).rejects.toThrow(ForbiddenException);
    });
  });

  // ── 3DS on an upgrade ────────────────────────────────────────────────────
  describe('changePlan — upgrade needing 3DS', () => {
    it('returns requiresAction + clientSecret (no throw) and keeps the old plan until confirmed', async () => {
      const sub = makeSub({
        status: 'active', platformPlanId: GROW._id, amountUSD: 29, totalPaidUSD: 29, providerSubscriptionId: PROVIDER_SUB, stripeCustomerId: 'cus_1', paymentProvider: 'stripe',
        currentPeriodStart: new Date(Date.now() - 5 * DAY), currentPeriodEnd: new Date(Date.now() + 25 * DAY), trialEndsAt: null,
      });
      const { service } = make(sub, { chargeSubscription: jest.fn().mockResolvedValue({ success: false, requiresAction: true, clientSecret: 'pi_3ds_secret', providerChargeId: 'pi_3ds' }) });
      jest.spyOn(service, 'verifyStoreOwnership').mockResolvedValue({});
      const res: any = await service.changePlan('seller-1', 'store-1', { platformPlanId: PRO._id, billingInterval: 'monthly' });

      expect(res.data).toMatchObject({ requiresAction: true, clientSecret: 'pi_3ds_secret', pending: true });
      expect(sub.platformPlanId).toBe(GROW._id);
      expect(sub.pendingPlanChange).toMatchObject({ kind: 'upgrade', planId: PRO._id, paymentIntentId: 'pi_3ds' });
    });

    it('confirmPendingPlanChange applies the plan only once Stripe says the PaymentIntent succeeded', async () => {
      const sub = makeSub({
        status: 'active', platformPlanId: GROW._id, amountUSD: 29, totalPaidUSD: 29, providerSubscriptionId: PROVIDER_SUB, paymentProvider: 'stripe', trialEndsAt: null,
        pendingPlanChange: { kind: 'upgrade', planId: PRO._id, interval: 'monthly', amountUSD: 79, paymentIntentId: 'pi_3ds', chargedUSD: 50, subtotalUSD: 50, taxUSD: 0, createdAt: NOW },
      });
      const getStatus = jest.fn().mockResolvedValueOnce('requires_action').mockResolvedValueOnce('succeeded');
      const { service } = make(sub, { getPaymentIntentStatus: getStatus });
      jest.spyOn(service, 'verifyStoreOwnership').mockResolvedValue({});

      const first: any = await service.confirmPendingPlanChange('seller-1', 'store-1');
      expect(first.data.applied).toBe(false);
      expect(sub.platformPlanId).toBe(GROW._id);

      const second: any = await service.confirmPendingPlanChange('seller-1', 'store-1');
      expect(second.data.applied).toBe(true);
      expect(sub.platformPlanId).toBe(PRO._id);
      expect(sub.pendingPlanChange).toBeNull();
    });
  });

  // ── invoice.payment_succeeded ────────────────────────────────────────────
  describe('handleInvoicePaymentSucceeded', () => {
    it('applies the pending plan (history, cleared pending, active) and sends the payment-received email exactly once', async () => {
      const sub = makeSub({ status: 'trial_ended', providerSubscriptionId: PROVIDER_SUB, pendingPlanChange: pendingOf('first_purchase') });
      const { service, notifications, notificationsService, invoiceModel } = make(sub);
      await service.handleInvoicePaymentSucceeded(paidInvoice());
      await flush();

      expect(sub.platformPlanId).toBe(GROW._id);
      expect(sub.amountUSD).toBe(29);
      expect(sub.status).toBe('active');
      expect(sub.pendingPlanChange).toBeNull();
      expect(sub.planHistory).toHaveLength(1);
      expect(sub.planHistory[0]).toMatchObject({ toPlanId: GROW._id, fromPlanId: null });
      expect(invoiceModel.create.mock.calls[0][0][0].platformPlanId).toBe(GROW._id);
      expect(notifications.sendPaymentReceived).toHaveBeenCalledTimes(1);
      expect(notifications.sendPaymentReceived.mock.calls[0][1]).toMatchObject({ amountUSD: 29, invoiceUrl: 'https://stripe.test/i/1', planName: 'Grow' });
      expect(notificationsService.notify).toHaveBeenCalledTimes(1);

      // duplicate webhook delivery: dedup returns early, no second email
      invoiceModel.exists.mockResolvedValue({ _id: 'inv1' });
      await service.handleInvoicePaymentSucceeded(paidInvoice());
      await flush();
      expect(notifications.sendPaymentReceived).toHaveBeenCalledTimes(1);
    });

    it('ignores the $0 invoice Stripe issues when a trial subscription starts', async () => {
      const sub = makeSub({ status: 'trialing', providerSubscriptionId: PROVIDER_SUB, pendingPlanChange: pendingOf('trial_conversion') });
      const { service, notifications } = make(sub);
      await service.handleInvoicePaymentSucceeded(paidInvoice({ amount_paid: 0, amount_due: 0 }));
      expect(sub.platformPlanId).toBeNull();
      expect(sub.status).toBe('trialing');
      expect(sub.pendingPlanChange).not.toBeNull();
      expect(notifications.sendPaymentReceived).not.toHaveBeenCalled();
    });
  });

  // ── invoice.payment_failed / incomplete_expired ──────────────────────────
  describe('failed / abandoned payment keeps the prior state', () => {
    it.each([
      ['trialing', null, 0], ['trial_ended', null, 0], ['locked', GROW._id, 29], ['active', GROW._id, 29],
    ])('payment_failed on a pending first purchase from %s changes nothing', async (status, planId, amount) => {
      const sub = makeSub({ status, platformPlanId: planId, amountUSD: amount, providerSubscriptionId: PROVIDER_SUB, pendingPlanChange: pendingOf('first_purchase', { planId: PRO._id }) });
      const { service, notifications } = make(sub);
      await service.handleInvoicePaymentFailed({ id: 'in_f', subscription: PROVIDER_SUB, amount_due: 7900 });

      expect(sub.status).toBe(status);
      expect(sub.platformPlanId).toBe(planId);
      expect(sub.amountUSD).toBe(amount);
      expect(sub.pastDueSince ?? null).toBeNull();
      expect(sub.lastBillingError).toBeTruthy();
      expect(sub.pendingPlanChange).not.toBeNull();
      expect(notifications.sendPaymentFailed).not.toHaveBeenCalled();
    });

    it('a failed trial-end charge shows the blocking trial_ended gate with the reason but keeps the Stripe sub so its retries can still collect (Shopify-like)', async () => {
      const sub = makeSub({ status: 'trialing', providerSubscriptionId: PROVIDER_SUB, pendingPlanChange: pendingOf('trial_conversion') });
      const { service, gateway } = make(sub);
      await service.handleInvoicePaymentFailed({ id: 'in_f', subscription: PROVIDER_SUB, amount_due: 2900, billing_reason: 'subscription_cycle' });

      expect(sub.status).toBe('trial_ended');
      expect(sub.platformPlanId).toBeNull();
      expect(sub.pendingPlanChange).not.toBeNull();
      expect(sub.providerSubscriptionId).toBe(PROVIDER_SUB);
      expect(sub.lastBillingError).toBeTruthy();
      expect(gateway.cancelProviderSubscription).not.toHaveBeenCalled();
    });

    it('a Stripe retry that finally succeeds after the failure applies the plan and lifts the gate', async () => {
      const sub = makeSub({ status: 'trial_ended', providerSubscriptionId: PROVIDER_SUB, lastBillingError: 'declined', pendingPlanChange: pendingOf('trial_conversion') });
      const { service } = make(sub);
      await service.handleInvoicePaymentSucceeded(paidInvoice({ billing_reason: 'subscription_cycle' }));
      expect(sub.status).toBe('active');
      expect(sub.platformPlanId).toBe(GROW._id);
      expect(sub.lastBillingError).toBeNull();
    });

    it('incomplete_expired clears pending + providerSubscriptionId without setting canceled', async () => {
      const sub = makeSub({ status: 'trial_ended', providerSubscriptionId: PROVIDER_SUB, paymentProvider: 'stripe', pendingPlanChange: pendingOf('first_purchase') });
      const { service } = make(sub);
      await service.handleSubscriptionUpdated({ id: PROVIDER_SUB, status: 'incomplete_expired' });

      expect(sub.pendingPlanChange).toBeNull();
      expect(sub.providerSubscriptionId).toBeNull();
      expect(sub.status).toBe('trial_ended');
      expect(sub.platformPlanId).toBeNull();
    });
  });

  // ── proration ────────────────────────────────────────────────────────────
  describe('computeProration — credit only for a paid period', () => {
    const base = { amountUSD: 29, creditBalanceUSD: 0, currentPeriodStart: new Date(Date.now() - 10 * DAY), currentPeriodEnd: new Date(Date.now() + 20 * DAY) };
    it('past_due / unpaid → 0 credit, full price due', () => {
      const { service } = make(makeSub());
      const r = service.computeProration({ ...base, status: 'past_due', totalPaidUSD: 0 }, PRO, 'monthly');
      expect(r.unusedCredit).toBe(0);
      expect(r.willChargeUSD).toBe(79);
    });
    it('active but never paid (totalPaidUSD 0) → 0 credit', () => {
      const { service } = make(makeSub());
      expect(service.computeProration({ ...base, status: 'active', totalPaidUSD: 0 }, PRO, 'monthly').unusedCredit).toBe(0);
    });
    it('active and paid → pro-rata credit as before', () => {
      const { service } = make(makeSub());
      expect(service.computeProration({ ...base, status: 'active', totalPaidUSD: 29 }, PRO, 'monthly').unusedCredit).toBeGreaterThan(15);
    });
  });

  // ── Complimentary (admin-given) plans ─────────────────────────────────────
  describe('complimentary plans', () => {
    const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();
    const comp = (over: Record<string, any> = {}) => ({ grantedBy: 'a', grantedByName: 'Admin Amy', grantedAt: new Date(), reason: 'Partner agency', reviewAt: null, planPriceUSD: 79, ...over });

    it('assigning needs a reason and a future review date', async () => {
      const { service } = make(makeSub({ status: 'trial_ended' }));
      await expect(service.adminAssignPlan('admin-1', 'store-1', PRO._id, '  ', undefined)).rejects.toThrow(/Say why/);
      await expect(service.adminAssignPlan('admin-1', 'store-1', PRO._id, 'partner', new Date(Date.now() - DAY).toISOString())).rejects.toThrow(/future/);
    });

    it('records who/why/when, gives the plan for free (no revenue) and keeps the list price', async () => {
      const sub = makeSub({ status: 'trial_ended', providerSubscriptionId: 'sub_old' });
      const { service, gateway } = make(sub);
      await service.adminAssignPlan('admin-1', 'store-1', PRO._id, 'Partner agency', inDays(30));
      expect(gateway.cancelProviderSubscription).toHaveBeenCalledWith('sub_old');
      expect(sub.status).toBe('active');
      expect(sub.platformPlanId).toBe(PRO._id);
      expect(sub.amountUSD).toBe(0);
      expect(sub.paymentProvider).toBe('manual');
      expect(sub.complimentary).toMatchObject({ grantedBy: 'admin-1', grantedByName: 'Admin Amy', reason: 'Partner agency', planPriceUSD: 79 });
      expect(sub.complimentary.reviewAt).toBeInstanceOf(Date);
      expect(sub.planHistory[0]).toMatchObject({ source: 'admin', reason: 'Partner agency', amountUSD: 0 });
    });

    it('a FREE plan is just a plain free plan, not complimentary', async () => {
      const sub = makeSub({ status: 'trial_ended' });
      const { service } = make(sub);
      await service.adminAssignPlan('admin-1', 'store-1', FREE._id, 'free tier');
      expect(sub.complimentary).toBeNull();
    });

    it('the renewal job never selects a complimentary store', async () => {
      const { service, subModel } = make(makeSub());
      await service.processRenewals();
      expect(subModel.find.mock.calls[0][0]).toMatchObject({ complimentary: null, paymentProvider: 'manual' });
    });

    it('removing it sends the store back to the Select-a-plan gate; removing a non-complimentary store is refused', async () => {
      const sub = makeSub({ status: 'active', platformPlanId: PRO._id, complimentary: comp() });
      const { service } = make(sub);
      await service.adminRemoveComplimentary('admin-1', 'store-1', 'review done');
      expect(sub.status).toBe('trial_ended');
      expect(sub.platformPlanId).toBeNull();
      expect(sub.complimentary).toBeNull();
      expect(sub.lastBillingError).toMatch(/complimentary plan/);
      await expect(service.adminRemoveComplimentary('admin-1', 'store-1')).rejects.toThrow(/does not have/);
    });

    it('a real payment replaces the complimentary plan', async () => {
      const sub = makeSub({ status: 'active', platformPlanId: PRO._id, providerSubscriptionId: PROVIDER_SUB, pendingPlanChange: pendingOf('first_purchase'), complimentary: comp() });
      const { service } = make(sub);
      await service.handleInvoicePaymentSucceeded(paidInvoice());
      expect(sub.complimentary).toBeNull();
      expect(sub.platformPlanId).toBe(GROW._id);
    });

    it('the seller cannot cancel a complimentary plan and never sees who gave it or why', async () => {
      const sub = makeSub({ status: 'active', platformPlanId: PRO._id, complimentary: comp({ reason: 'secret reason' }) });
      const { service, subModel } = make(sub);
      jest.spyOn(service, 'verifyStoreOwnership').mockResolvedValue({});
      await expect(service.cancelSubscription('seller-1', 'store-1')).rejects.toThrow(/provided by Solvexo support/);
      subModel.findOne = jest.fn(() => ({ lean: () => Promise.resolve(sub) }));
      const res: any = await service.getStorePlan('seller-1', 'store-1');
      expect(res.data.complimentary).toEqual({ active: true, since: expect.any(Date) });
      expect(JSON.stringify(res.data.complimentary)).not.toContain('secret');
    });

    it('review reminders: once when due within 7 days, once more when overdue, never twice for the same date', async () => {
      const sub = makeSub({ status: 'active', platformPlanId: PRO._id, complimentary: comp({ reviewAt: new Date(Date.now() + 3 * DAY) }) });
      const { service, notificationsService } = make(sub);
      expect(await service.sendComplimentaryReviewReminders()).toEqual({ soon: 1, overdue: 0 });
      expect(notificationsService.notifyAdmins).toHaveBeenCalledTimes(1);
      expect(await service.sendComplimentaryReviewReminders()).toEqual({ soon: 0, overdue: 0 });
      sub.complimentary.reviewAt = new Date(Date.now() - DAY);
      expect(await service.sendComplimentaryReviewReminders()).toEqual({ soon: 0, overdue: 1 });
      expect(notificationsService.notifyAdmins).toHaveBeenCalledTimes(2);
    });

    it('the admin list shows reason, who, review state and totals', async () => {
      const sub = makeSub({ status: 'active', platformPlanId: PRO._id, complimentary: comp({ reviewAt: new Date(Date.now() + 3 * DAY) }) });
      const { service } = make(sub);
      service.subModel.find = jest.fn(() => ({ lean: () => Promise.resolve([sub]) }));
      service.storeModel.find = jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve([{ _id: 'store-1', name: 'Ali Shoes' }]) }) }));
      service.planModel.find = jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve([{ _id: PRO._id, name: 'Pro' }]) }) }));
      const { data } = (await service.adminListComplimentary()) as any;
      expect(data.items[0]).toMatchObject({ storeName: 'Ali Shoes', planName: 'Pro', reason: 'Partner agency', grantedBy: 'Admin Amy', reviewState: 'soon' });
      expect(data).toMatchObject({ count: 1, dueSoon: 1, overdue: 0, monthlyValueUSD: 79 });
    });
  });

  // ── lockOverduePastDue ───────────────────────────────────────────────────
  describe('lockOverduePastDue — all stores', () => {
    const old = new Date(NOW.getTime() - (PAST_DUE_LOCK_DAYS + 7) * DAY);
    it('locks a non-legacy store', async () => {
      const sub = makeSub({ status: 'past_due', platformPlanId: GROW._id, pastDueSince: old });
      const { service } = make(sub);
      expect((await service.lockOverduePastDue(NOW)).locked).toBe(1);
      expect(sub.status).toBe('locked');
    });
    it('downgrades a legacy store to free (instead of skipping it forever)', async () => {
      const sub = makeSub({ status: 'past_due', platformPlanId: GROW._id, amountUSD: 29, pastDueSince: old, legacyFreeEligible: true });
      const { service, notifications } = make(sub);
      expect((await service.lockOverduePastDue(NOW)).locked).toBe(1);
      expect(sub.status).toBe('active');
      expect(sub.platformPlanId).toBe(FREE._id);
      expect(sub.amountUSD).toBe(0);
      expect(notifications.sendDowngradedDueToFailedPayments).toHaveBeenCalled();
    });
    it('a legacy store is LOCKED (not left on the paid plan) when no free plan exists to downgrade to', async () => {
      const sub = makeSub({ status: 'past_due', platformPlanId: GROW._id, amountUSD: 29, pastDueSince: old, legacyFreeEligible: true });
      const { service, notifications } = make(sub, {}, (q: any) => (q?.isFree ? null : null));
      expect((await service.lockOverduePastDue(NOW)).locked).toBe(1);
      expect(sub.status).toBe('locked');
      expect(notifications.sendStoreLocked).toHaveBeenCalled();
      expect(notifications.sendDowngradedDueToFailedPayments).not.toHaveBeenCalled();
    });
    it('failed dunning sets pastDueSince', async () => {
      const sub = makeSub({ status: 'active', platformPlanId: GROW._id, amountUSD: 29, providerSubscriptionId: 'sub_x' });
      const { service } = make(sub);
      await service.applyDunningFailure(sub, 29, null);
      expect(sub.status).toBe('past_due');
      expect(sub.pastDueSince).toBeInstanceOf(Date);
    });
  });
});

describe('EntitlementsService.getLimits — canceled', () => {
  it('gives no paid limits (FALLBACK) for a canceled subscription', async () => {
    const paid = { _id: 'p', name: 'Pro', limits: { maxProducts: 9999, customDomainAllowed: true } };
    const db: any = { repositories: {
      sellerPlatformSubscriptionModel: { findOne: () => leanOf({ status: 'canceled', platformPlanId: 'p' }) },
      platformPlanModel: { findById: () => leanOf(paid), findOne: () => leanOf(null) },
    } };
    const leanOf = (v: any) => ({ lean: () => Promise.resolve(v) });
    const limits: any = await new EntitlementsService(db).getLimits('store-1');
    expect(limits.maxProducts).not.toBe(9999);
    expect(limits.customDomainAllowed).toBe(false);
  });
});
