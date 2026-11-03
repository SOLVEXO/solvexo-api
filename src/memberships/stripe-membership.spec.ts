import { MembershipsService } from './memberships.service';
import { StripeMembershipProvider } from './stripe-membership.provider';
import { MembershipStripeWebhookService } from './membership-stripe-webhook.service';
import { SUBSCRIPTION_PROVIDERS } from './subscription-provider';
import { FakeModel, makeDb } from '../digital-access/testing/fake-db.kit-spec';

const DAY = 86_400_000;
const LIVE = ['trialing', 'active', 'past_due', 'paused'];
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

class SubModel extends FakeModel {
  async create(d: any) {
    if (this.rows.some((r) => r.customerId === d.customerId && r.planId === d.planId && LIVE.includes(r.status))) throw Object.assign(new Error('E11000'), { code: 11000 });
    return super.create(d);
  }
}
class EventModel extends FakeModel {
  unique = ['providerEventId'];
  async create(d: any) { return super.create({ updatedAt: new Date(), ...d }); }
}

function fakeStripe() {
  const calls: Record<string, any[]> = { checkout: [], subUpdate: [], subCancel: [], product: [], portal: [], retrieve: [] };
  const remote: any = { status: 'active', current_period_start: unix(new Date()), current_period_end: unix(new Date(Date.now() + 30 * DAY)), items: { data: [{ id: 'si_1' }] } };
  const client: any = {
    checkout: { sessions: { create: async (a: any, o: any) => { calls.checkout.push({ a, o }); return { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }; } } },
    products: { create: async (a: any, o: any) => { calls.product.push({ a, o }); return { id: 'prod_1' }; } },
    subscriptions: {
      retrieve: async (id: string) => { calls.retrieve.push(id); return remote; },
      update: async (id: string, a: any) => { calls.subUpdate.push({ id, a }); return remote; },
      cancel: async (id: string) => { calls.subCancel.push(id); },
    },
    billingPortal: { sessions: { create: async (a: any) => { calls.portal.push(a); return { url: 'https://portal.stripe.test/p' }; } } },
    webhooks: { constructEvent: (raw: Buffer, sig: string) => { if (sig !== 'valid-sig') throw new Error('No signatures found matching the expected signature'); return JSON.parse(raw.toString()); } },
  };
  return { calls, client, remote };
}

function setup(cfgOver: Record<string, string> = {}, storeOver: any = {}) {
  const k = makeDb();
  const plans = new FakeModel({ status: 'active', graceDays: 0, trialDays: 0, tier: 1, intervalCount: 1, interval: 'month', pauseAllowed: true, productId: null, autoRenew: false, stripeProductId: null });
  const subs = new SubModel({ appliedItemIds: [], periodsPaid: 0, failedCount: 0, cancelAtPeriodEnd: false, reminderSentFor: null, pendingPlanId: null, audit: [], awaitingFirstPayment: false, provider: 'manual' });
  const events = new EventModel();
  (k.db.repositories as any).webhookEventModel = events;
  plans.rows.push(
    { _id: 'gold', storeId: 's1', name: 'Gold', type: 'recurring', amount: 20, currency: 'USD', autoRenew: true, tier: 1, graceDays: 2, trialDays: 7, pauseAllowed: true, status: 'active', interval: 'month', intervalCount: 1, productId: null, stripeProductId: null },
    { _id: 'pro', storeId: 's1', name: 'Pro', type: 'recurring', amount: 50, currency: 'USD', autoRenew: true, tier: 2, graceDays: 0, trialDays: 0, pauseAllowed: false, status: 'active', interval: 'month', intervalCount: 1, productId: null, stripeProductId: null },
    { _id: 'manualplan', storeId: 's1', name: 'Manual', type: 'recurring', amount: 10, currency: 'USD', autoRenew: false, tier: 1, graceDays: 0, trialDays: 0, pauseAllowed: false, status: 'active', interval: 'month', intervalCount: 1, productId: null, stripeProductId: null },
  );
  k.storeModel.rows.push({ _id: 's1', slug: 'demo', country: 'US', baseCurrency: 'USD', isDelete: false, ...storeOver });
  k.userModel.rows.push({ _id: 'c1', name: 'Ayesha', email: 'a@example.com' });
  const cfg: Record<string, string> = { STRIPE_SECRET_KEY: 'sk_test_x', MEMBERSHIPS_STRIPE_ENABLED: 'true', MEMBERSHIPS_STRIPE_WEBHOOK_SECRET: 'whsec_x', ...cfgOver };
  const config: any = { get: (key: string) => cfg[key] };
  let connectAccount: string | null = 'acct_seller';
  const connect: any = { getEligibleConnectAccountForStore: async () => connectAccount };
  const stripeFake = fakeStripe();
  const provider = new StripeMembershipProvider(k.db, connect, config);
  (provider as any)._client = stripeFake.client;
  const mailer: any = { membership: jest.fn() };
  const svc = new MembershipsService(k.db, plans as any, subs as any, mailer, provider);
  const webhook = new MembershipStripeWebhookService(k.db, provider, svc);
  return { ...k, plans, subs, events, provider, svc, webhook, mailer, stripe: stripeFake, setConnect: (a: string | null) => { connectAccount = a; } };
}
type S = ReturnType<typeof setup>;

const event = (type: string, object: any, id = 'evt_' + Math.random().toString(36).slice(2)) => ({ id, type, data: { object } });
const raw = (e: any) => Buffer.from(JSON.stringify(e));
const completed = (over: any = {}) => ({ id: 'cs_1', mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', metadata: { purpose: 'member_subscription', storeId: 's1', customerId: 'c1', planId: 'gold' }, ...over });
const invoice = (over: any = {}) => ({ id: 'in_1', subscription: 'sub_1', amount_paid: 2000, total: 2000, billing_reason: 'subscription_create', lines: { data: [{ period: { start: unix(new Date()), end: unix(new Date(Date.now() + 30 * DAY)) } }] }, ...over });

async function joinViaStripe(s: S) {
  await s.webhook.receive(raw(event('checkout.session.completed', completed())), 'valid-sig');
  return s.subs.rows[0];
}

describe('Stripe availability gate (country / currency / account)', () => {
  it('is off until the platform switches it on', async () => {
    const s = setup({ MEMBERSHIPS_STRIPE_ENABLED: 'false' });
    expect((await s.provider.availability('s1')).available).toBe(false);
  });

  it('a Pakistani store is refused with a plain reason (Stripe Connect is not offered there)', async () => {
    const s = setup({}, { country: 'PK', baseCurrency: 'PKR' });
    const a = await s.provider.availability('s1');
    expect(a.available).toBe(false);
    expect(a.reason).toContain('Pakistan');
    await expect(s.svc.createPlan('s1', { name: 'X', type: 'recurring', amount: 5, autoRenew: true })).rejects.toThrow('Pakistan');
  });

  it('a US store without finished Connect onboarding is refused; with it, allowed', async () => {
    const s = setup();
    s.setConnect(null);
    expect((await s.provider.availability('s1')).reason).toContain('Connect your Stripe account');
    s.setConnect('acct_seller');
    expect((await s.provider.availability('s1')).available).toBe(true);
    expect((await s.svc.billingMode('s1')).mode).toBe('auto');
  });

  it('a live key is refused unless explicitly allowed (test mode only)', () => {
    const cfg: any = { get: (k: string) => ({ STRIPE_SECRET_KEY: 'sk_live_abc' } as any)[k] };
    expect(() => new StripeMembershipProvider(makeDb().db, {} as any, cfg).client()).toThrow('test mode');
  });
});

describe('checkout (money goes to the seller)', () => {
  it('creates a subscription checkout that transfers everything to the seller and takes no fee', async () => {
    const s = setup();
    const r = await s.svc.startStripeCheckout('s1', 'c1', 'gold');
    expect(r.url).toContain('checkout.stripe.test');
    const { a, o } = s.stripe.calls.checkout[0];
    expect(a.mode).toBe('subscription');
    expect(a.subscription_data.transfer_data.destination).toBe('acct_seller');
    expect(JSON.stringify(a).includes('application_fee')).toBe(false);
    expect(a.subscription_data.trial_period_days).toBe(7);
    expect(a.metadata.purpose).toBe('member_subscription');
    expect(a.line_items[0].price_data.unit_amount).toBe(2000);
    expect(a.line_items[0].price_data.recurring.interval).toBe('month');
    expect(o.idempotencyKey).toContain('memcheckout:s1:c1:gold');
  });

  it('only auto-renew recurring plans can be bought this way, and not twice', async () => {
    const s = setup();
    await expect(s.svc.startStripeCheckout('s1', 'c1', 'manualplan')).rejects.toThrow('not charged automatically');
    await expect(s.svc.startStripeCheckout('s1', 'c1', 'nope')).rejects.toThrow('Plan not found');
    await joinViaStripe(s);
    await expect(s.svc.startStripeCheckout('s1', 'c1', 'gold')).rejects.toThrow('already have');
  });

  it('refuses a store Stripe cannot serve', async () => {
    const s = setup({}, { country: 'PK' });
    await expect(s.svc.startStripeCheckout('s1', 'c1', 'gold')).rejects.toThrow('Pakistan');
  });
});

describe('webhook: signature + idempotency', () => {
  it('rejects a bad or missing signature and an unconfigured secret', async () => {
    const s = setup();
    const body = raw(event('invoice.paid', invoice()));
    await expect(s.webhook.receive(body, 'forged')).rejects.toThrow('signature verification failed');
    await expect(s.webhook.receive(body, undefined)).rejects.toThrow('Missing Stripe signature');
    await expect(setup({ MEMBERSHIPS_STRIPE_WEBHOOK_SECRET: '' }).webhook.receive(body, 'valid-sig')).rejects.toThrow('WEBHOOK_SECRET');
  });

  it('a duplicate delivery of the same event is acknowledged and applied once', async () => {
    const s = setup();
    const e = event('checkout.session.completed', completed(), 'evt_dup');
    const a: any = await s.webhook.receive(raw(e), 'valid-sig');
    const b: any = await s.webhook.receive(raw(e), 'valid-sig');
    expect(a.duplicate).toBeFalsy();
    expect(b.duplicate).toBe(true);
    expect(s.subs.rows.length).toBe(1);
    expect(s.events.rows[0].status).toBe('processed');
    expect(s.events.rows[0].providerEventId).toBe('membership:evt_dup');
  });

  it('a failed event is processed again on the retry (and Stripe gets a 5xx)', async () => {
    const s = setup();
    const e = event('checkout.session.completed', completed(), 'evt_retry');
    const real = s.svc.applyStripeEvent.bind(s.svc);
    let fail = true;
    (s.svc as any).applyStripeEvent = async (ev: any) => { if (fail) { fail = false; throw new Error('db down'); } return real(ev); };
    await expect(s.webhook.receive(raw(e), 'valid-sig')).rejects.toThrow('db down');
    expect(s.events.rows[0].status).toBe('failed');
    await s.webhook.receive(raw(e), 'valid-sig');
    expect(s.events.rows[0].status).toBe('processed');
    expect(s.subs.rows.length).toBe(1);
  });

  it('events that are not ours are ignored', async () => {
    const s = setup();
    await s.webhook.receive(raw(event('checkout.session.completed', completed({ metadata: { purpose: 'pos_purchase' } }))), 'valid-sig');
    await s.webhook.receive(raw(event('invoice.paid', invoice({ subscription: 'sub_unknown' }))), 'valid-sig');
    expect(s.subs.rows.length).toBe(0);
    expect(s.events.rows.every((r) => r.status === 'ignored')).toBe(true);
  });
});

describe('subscription lifecycle from Stripe events', () => {
  it('checkout.session.completed creates an active stripe membership with its period and welcome mail', async () => {
    const s = setup();
    const sub = await joinViaStripe(s);
    expect(sub.provider).toBe('stripe');
    expect(sub.providerSubscriptionId).toBe('sub_1');
    expect(sub.providerCustomerId).toBe('cus_1');
    expect(sub.status).toBe('active');
    expect(sub.currentPeriodEnd > new Date()).toBe(true);
    expect(s.mailer.membership.mock.calls[0][0]).toBe('membership_welcome');
    expect(await s.svc.hasPlanAccess('s1', 'c1', 'gold')).toBe(true);
  });

  it('a trial starts as trialing', async () => {
    const s = setup();
    s.stripe.remote.status = 'trialing';
    const sub = await joinViaStripe(s);
    expect(sub.status).toBe('trialing');
    expect(sub.periodsPaid).toBe(0);
  });

  it('invoice.paid renews the period once per invoice (replay-safe) and clears dunning', async () => {
    const s = setup();
    const sub = await joinViaStripe(s);
    sub.status = 'past_due'; sub.dueAt = new Date(); sub.failedCount = 2;
    const end = new Date(Date.now() + 60 * DAY);
    const inv = invoice({ id: 'in_2', lines: { data: [{ period: { start: unix(new Date()), end: unix(end) } }] } });
    await s.webhook.receive(raw(event('invoice.paid', inv, 'e1')), 'valid-sig');
    await s.webhook.receive(raw(event('invoice.paid', inv, 'e2')), 'valid-sig'); // same invoice, different event id
    expect(sub.status).toBe('active');
    expect(sub.failedCount).toBe(0);
    expect(sub.dueAt).toBeNull();
    expect(sub.periodsPaid).toBe(2);
    expect(Math.abs(sub.currentPeriodEnd.getTime() - end.getTime()) < 2000).toBe(true);
  });

  it('invoice.payment_failed: past_due, access during grace, none after, mails first as payment_failed then as grace', async () => {
    const s = setup();
    const sub = await joinViaStripe(s);
    s.mailer.membership.mock.calls.length = 0;
    await s.webhook.receive(raw(event('invoice.payment_failed', invoice({ id: 'in_3', attempt_count: 1 }), 'f1')), 'valid-sig');
    await s.webhook.receive(raw(event('invoice.payment_failed', invoice({ id: 'in_3', attempt_count: 2 }), 'f2')), 'valid-sig');
    await s.webhook.receive(raw(event('invoice.payment_failed', invoice({ id: 'in_3', attempt_count: 2 }), 'f3')), 'valid-sig'); // replay of attempt 2
    expect(sub.status).toBe('past_due');
    expect(sub.failedCount).toBe(2);
    expect(s.mailer.membership.mock.calls.map((c: any[]) => c[0])).toEqual(['membership_payment_failed', 'membership_grace_period', 'membership_grace_period']);
    expect(await s.svc.hasPlanAccess('s1', 'c1', 'gold', new Date(sub.dueAt.getTime() + 1 * DAY))).toBe(true);
    expect(await s.svc.hasPlanAccess('s1', 'c1', 'gold', new Date(sub.dueAt.getTime() + 3 * DAY))).toBe(false);
  });

  it('customer.subscription.updated syncs pause, resume and cancel-at-period-end', async () => {
    const s = setup();
    const sub = await joinViaStripe(s);
    await s.webhook.receive(raw(event('customer.subscription.updated', { id: 'sub_1', status: 'active', cancel_at_period_end: true, pause_collection: { behavior: 'void' } }, 'u1')), 'valid-sig');
    expect(sub.status).toBe('paused');
    expect(sub.cancelAtPeriodEnd).toBe(true);
    await s.webhook.receive(raw(event('customer.subscription.updated', { id: 'sub_1', status: 'active', cancel_at_period_end: false, pause_collection: null }, 'u2')), 'valid-sig');
    expect(sub.status).toBe('active');
    expect(sub.cancelAtPeriodEnd).toBe(false);
  });

  it('customer.subscription.deleted: cancelled when the buyer asked, expired otherwise', async () => {
    const asked = setup();
    const a = await joinViaStripe(asked);
    a.cancelAtPeriodEnd = true;
    await asked.webhook.receive(raw(event('customer.subscription.deleted', { id: 'sub_1' }, 'd1')), 'valid-sig');
    expect(a.status).toBe('cancelled');
    const unpaid = setup();
    const b = await joinViaStripe(unpaid);
    await unpaid.webhook.receive(raw(event('customer.subscription.deleted', { id: 'sub_1' }, 'd2')), 'valid-sig');
    expect(b.status).toBe('expired');
  });
});

describe('member actions on a Stripe membership', () => {
  it('cancel at period end / pause / resume are sent to Stripe', async () => {
    const s = setup();
    const sub = await joinViaStripe(s);
    await s.svc.cancel('s1', 'c1', sub._id);
    expect(s.stripe.calls.subUpdate[0].a.cancel_at_period_end).toBe(true);
    expect(sub.cancelAtPeriodEnd).toBe(true);
    const s2 = setup();
    const sub2 = await joinViaStripe(s2);
    await s2.svc.pause('s1', 'c1', sub2._id);
    expect(s2.stripe.calls.subUpdate[0].a.pause_collection.behavior).toBe('void');
    expect(sub2.status).toBe('paused');
    await s2.svc.resume('s1', 'c1', sub2._id);
    expect(s2.stripe.calls.subUpdate[1].a.pause_collection).toBe('');
    expect(sub2.status).toBe('active');
  });

  it('upgrade is prorated and invoiced by Stripe; downgrade waits and is applied on the next cycle invoice', async () => {
    const s = setup();
    const sub = await joinViaStripe(s);
    const up: any = await s.svc.changePlan('s1', 'c1', sub._id, 'pro');
    expect(up.effective).toBe('now');
    expect(up.billedAutomatically).toBe(true);
    const call = s.stripe.calls.subUpdate[0];
    expect(call.a.proration_behavior).toBe('always_invoice');
    expect(call.a.items[0].id).toBe('si_1');
    expect(call.a.items[0].price_data.unit_amount).toBe(5000);
    expect(sub.planId).toBe('pro');

    const down: any = await s.svc.changePlan('s1', 'c1', sub._id, 'gold');
    expect(down.effective).toBe('period_end');
    expect(s.stripe.calls.subUpdate.length).toBe(1);
    expect(sub.pendingPlanId).toBe('gold');
    await s.webhook.receive(raw(event('invoice.paid', invoice({ id: 'in_cycle', billing_reason: 'subscription_cycle' }), 'c1')), 'valid-sig');
    expect(s.stripe.calls.subUpdate[1].a.proration_behavior).toBe('none');
    expect(sub.planId).toBe('gold');
    expect(sub.pendingPlanId).toBeNull();
  });

  it('the member can open the card-update page; manual memberships cannot', async () => {
    const s = setup();
    const sub = await joinViaStripe(s);
    expect((await s.svc.paymentMethodUrl('s1', 'c1', sub._id)).url).toContain('portal.stripe.test');
    expect(s.stripe.calls.portal[0].customer).toBe('cus_1');
    sub.provider = 'manual';
    await expect(s.svc.paymentMethodUrl('s1', 'c1', sub._id)).rejects.toThrow('not paid by card');
  });

  it('the seller cannot mark a Stripe membership paid by hand; other customers cannot touch it', async () => {
    const s = setup();
    const sub = await joinViaStripe(s);
    await expect(s.svc.markPaid('s1', sub._id, 'seller')).rejects.toThrow('charged automatically');
    await expect(s.svc.cancel('s1', 'c2', sub._id)).rejects.toThrow('Membership not found');
  });
});

describe('renewal + dunning jobs', () => {
  it('the clock never ends or dunns a Stripe membership (Stripe webhooks drive it)', async () => {
    const s = setup();
    const sub = await joinViaStripe(s);
    sub.currentPeriodEnd = new Date(Date.now() - DAY);
    await s.svc.processRenewals();
    expect(sub.status).toBe('active');
  });

  it('after 7 days of failed card payments the subscription is ended on Stripe and expires', async () => {
    const s = setup();
    const sub = await joinViaStripe(s);
    sub.status = 'past_due'; sub.dueAt = new Date(Date.now() - 6 * DAY);
    expect(await s.svc.reconcileStripeDunning()).toBe(0);
    sub.dueAt = new Date(Date.now() - 8 * DAY);
    expect(await s.svc.reconcileStripeDunning()).toBe(1);
    expect(await s.svc.reconcileStripeDunning()).toBe(0); // idempotent
    expect(s.stripe.calls.subCancel).toEqual(['sub_1']);
    expect(sub.status).toBe('expired');
  });

  it('manual billing still works next to Stripe', async () => {
    const s = setup();
    const manual: any = await s.svc.join('s1', 'c1', 'manualplan');
    await s.svc.markPaid('s1', manual._id, 'seller');
    expect(manual.status).toBe('active');
    expect(manual.provider).toBe('manual');
  });
});

describe('providers', () => {
  it('Safepay (and the generic Stripe stub) stay NOT IMPLEMENTED without credentials', async () => {
    expect(SUBSCRIPTION_PROVIDERS.safepay.implemented).toBe(false);
    await expect(SUBSCRIPTION_PROVIDERS.safepay.cancel('x')).rejects.toThrow('not implemented');
    expect(SUBSCRIPTION_PROVIDERS.manual.implemented).toBe(true);
  });
});
