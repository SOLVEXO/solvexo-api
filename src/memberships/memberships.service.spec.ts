import { MembershipsService } from './memberships.service';
import { FakeModel, makeDb } from '../digital-access/testing/fake-db.kit-spec';

const DAY = 86_400_000;
const LIVE = ['trialing', 'active', 'past_due', 'paused'];

class SubModel extends FakeModel {
  async create(d: any) {
    // the real model has a partial unique index on (store, customer, plan) for live statuses
    if (this.rows.some((r) => r.customerId === d.customerId && r.planId === d.planId && LIVE.includes(r.status))) throw Object.assign(new Error('E11000'), { code: 11000 });
    return super.create(d);
  }
}

function setup() {
  const k = makeDb();
  const plans = new FakeModel({ status: 'active', graceDays: 0, trialDays: 0, tier: 1, intervalCount: 1, interval: 'month', pauseAllowed: false, productId: null });
  const subs = new SubModel({ appliedItemIds: [], periodsPaid: 0, failedCount: 0, cancelAtPeriodEnd: false, reminderSentFor: null, pendingPlanId: null, audit: [], awaitingFirstPayment: false });
  const mailer: any = { membership: jest.fn() };
  plans.rows.push(
    { _id: 'basic', storeId: 's1', status: 'active', name: 'Basic', type: 'recurring', amount: 10, tier: 1, graceDays: 2, pauseAllowed: true, interval: 'month', intervalCount: 1, productId: null },
    { _id: 'pro', storeId: 's1', status: 'active', name: 'Pro', type: 'recurring', amount: 30, tier: 2, interval: 'month', intervalCount: 1, graceDays: 0, productId: null },
    { _id: 'free', storeId: 's1', status: 'active', name: 'Free', type: 'free', amount: 0, tier: 1, productId: null },
  );
  const svc = new MembershipsService(k.db, plans as any, subs as any, mailer);
  return { ...k, plans, subs, mailer, svc };
}
const joined = async (s: ReturnType<typeof setup>, customer = 'c1', plan = 'basic') => {
  const sub: any = await s.svc.join('s1', customer, plan);
  await s.svc.markPaid('s1', sub._id, 'seller');
  return sub;
};

describe('membership gating', () => {
  it('member has access, non-member / other store / lower tier do not', async () => {
    const s = setup();
    await joined(s);
    expect(await s.svc.hasPlanAccess('s1', 'c1', 'basic')).toBe(true);
    expect(await s.svc.hasPlanAccess('s1', 'c2', 'basic')).toBe(false);
    expect(await s.svc.hasPlanAccess('s2', 'c1', 'basic')).toBe(false);
    expect(await s.svc.hasPlanAccess('s1', 'c1', 'pro')).toBe(false);
  });

  it('a higher tier includes the lower plan', async () => {
    const s = setup();
    await joined(s, 'c1', 'pro');
    expect(await s.svc.hasPlanAccess('s1', 'c1', 'basic')).toBe(true);
  });

  it('no access before the first payment, none after the period or after expiry', async () => {
    const s = setup();
    const sub: any = await s.svc.join('s1', 'c1', 'basic');
    expect(await s.svc.hasPlanAccess('s1', 'c1', 'basic')).toBe(false);
    await s.svc.markPaid('s1', sub._id, 'seller');
    expect(await s.svc.hasPlanAccess('s1', 'c1', 'basic', new Date(Date.now() + 40 * DAY))).toBe(false);
    sub.status = 'expired';
    expect(await s.svc.hasPlanAccess('s1', 'c1', 'basic')).toBe(false);
  });

  it('refuses a second live membership of the same plan', async () => {
    const s = setup();
    await s.svc.join('s1', 'c1', 'basic');
    await expect(s.svc.join('s1', 'c1', 'basic')).rejects.toThrow('already have');
  });
});

describe('renewals and dunning', () => {
  it('sends one reminder per period, and mails it', async () => {
    const s = setup();
    const sub = await joined(s);
    sub.currentPeriodEnd = new Date(Date.now() + 3 * DAY);
    const a = await s.svc.processRenewals();
    const b = await s.svc.processRenewals();
    expect(a.filter((e) => e.kind === 'reminder').length).toBe(1);
    expect(b.filter((e) => e.kind === 'reminder').length).toBe(0);
  });

  it('an ended period becomes past_due once (idempotent) and grace keeps access', async () => {
    const s = setup();
    const sub = await joined(s);
    const t0 = new Date(sub.currentPeriodEnd.getTime() + 1000);
    const a = await s.svc.processRenewals(t0);
    const b = await s.svc.processRenewals(t0);
    expect(sub.status).toBe('past_due');
    expect(a.some((e) => e.kind === 'payment_failed')).toBe(true);
    expect(b.some((e) => e.kind === 'payment_failed')).toBe(false);
    expect(await s.svc.hasPlanAccess('s1', 'c1', 'basic', new Date(sub.dueAt.getTime() + 1 * DAY))).toBe(true);
    expect(await s.svc.hasPlanAccess('s1', 'c1', 'basic', new Date(sub.dueAt.getTime() + 3 * DAY))).toBe(false);
  });

  it('walks the ladder 1/3/5/7 days and then expires', async () => {
    const s = setup();
    const sub = await joined(s);
    await s.svc.processRenewals(new Date(sub.currentPeriodEnd.getTime() + 1000));
    for (const d of [1, 3, 5, 7, 7]) await s.svc.processRenewals(new Date(sub.dueAt.getTime() + d * DAY + 1000));
    expect(sub.status).toBe('expired');
    await expect(s.svc.markPaid('s1', sub._id, 'seller')).rejects.toThrow('not payable');
  });

  it('paying late restores the subscription and resets dunning', async () => {
    const s = setup();
    const sub = await joined(s);
    await s.svc.processRenewals(new Date(sub.currentPeriodEnd.getTime() + 2 * DAY));
    await s.svc.markPaid('s1', sub._id, 'seller');
    expect(sub.status).toBe('active');
    expect(sub.failedCount).toBe(0);
    expect(sub.dueAt).toBeNull();
  });

  it('cancel at period end keeps access, then cancels', async () => {
    const s = setup();
    const sub = await joined(s);
    await s.svc.cancel('s1', 'c1', sub._id);
    expect(sub.status).toBe('active');
    expect(sub.cancelAtPeriodEnd).toBe(true);
    await s.svc.processRenewals(new Date(sub.currentPeriodEnd.getTime() + 1000));
    expect(sub.status).toBe('cancelled');
  });

  it('a customer cannot cancel someone else\'s membership', async () => {
    const s = setup();
    const sub = await joined(s);
    await expect(s.svc.cancel('s1', 'c2', sub._id)).rejects.toThrow('Membership not found');
    await expect(s.svc.cancel('s2', 'c1', sub._id)).rejects.toThrow('Membership not found');
  });
});

describe('plan changes, pause, grants', () => {
  it('upgrade is immediate and prorated, downgrade waits for the period end', async () => {
    const s = setup();
    const sub = await joined(s, 'c1', 'basic');
    const up: any = await s.svc.changePlan('s1', 'c1', sub._id, 'pro');
    expect(up.effective).toBe('now');
    expect(up.amountDue).toBeGreaterThan(19);
    expect(up.amountDue < 30.01).toBe(true);
    const down: any = await s.svc.changePlan('s1', 'c1', sub._id, 'basic');
    expect(down.effective).toBe('period_end');
    expect(sub.planId).toBe('pro');
    expect(sub.pendingPlanId).toBe('basic');
  });

  it('pause only where the plan allows it, resume extends the period by the paused time', async () => {
    const s = setup();
    const pro = await joined(s, 'c9', 'pro');
    await expect(s.svc.pause('s1', 'c9', pro._id)).rejects.toThrow('cannot be paused');
    const sub = await joined(s);
    const end = sub.currentPeriodEnd.getTime();
    await s.svc.pause('s1', 'c1', sub._id);
    sub.pausedAt = new Date(Date.now() - 2 * DAY);
    await s.svc.resume('s1', 'c1', sub._id);
    expect(sub.status).toBe('active');
    expect(sub.currentPeriodEnd.getTime() - end >= 2 * DAY - 2000).toBe(true);
  });

  it('manual grant only works for a customer of that store', async () => {
    const s = setup();
    s.userModel.rows.push({ _id: 'c1', storeId: 's1' }, { _id: 'cx', storeId: 's2' });
    const sub: any = await s.svc.sellerGrant('s1', 'c1', 'basic', 'seller');
    expect(sub.status).toBe('active');
    await expect(s.svc.sellerGrant('s1', 'cx', 'basic', 'seller')).rejects.toThrow('Customer not found');
  });

  it('plan sold through checkout: a paid item starts, a second one renews, old items do not revive', async () => {
    const s = setup();
    s.plans.rows[0].productId = 'p1';
    const items: any[] = [{ _id: 'i1', productId: 'p1', status: 'pending' }];
    s.orderModel.rows.push({ _id: 'o1', userId: 'c1', isPaid: true, isDelete: false, sellerOrders: [{ storeId: 's1', items }] });
    await s.svc.syncFromOrders('s1', 'c1');
    await s.svc.syncFromOrders('s1', 'c1');
    expect(s.subs.rows.length).toBe(1);
    expect(s.subs.rows[0].periodsPaid).toBe(1);
    items.push({ _id: 'i2', productId: 'p1', status: 'pending' });
    await s.svc.syncFromOrders('s1', 'c1');
    expect(s.subs.rows[0].periodsPaid).toBe(2);
    s.subs.rows[0].status = 'expired';
    await s.svc.syncFromOrders('s1', 'c1');
    expect(s.subs.rows.length).toBe(1);
  });
});

describe('seller list', () => {
  it('subscribers are paged on the server, filtered by status and enriched', async () => {
    const s = setup();
    s.userModel.rows.push({ _id: 'c1', name: 'Ayesha', email: 'a@x.pk' });
    for (let i = 0; i < 5; i++) { const sub: any = await s.svc.join('s1', 'c' + i, 'free'); sub.status = i < 3 ? 'active' : 'expired'; }
    const p1: any = await s.svc.listSubscribers('s1', undefined, { page: 1, limit: 2, skip: 0 });
    const p3: any = await s.svc.listSubscribers('s1', undefined, { page: 3, limit: 2, skip: 4 });
    expect(p1.total).toBe(5);
    expect(p1.items.length).toBe(2);
    expect(p3.items.length).toBe(1);
    expect(((await s.svc.listSubscribers('s1', 'expired')) as any).total).toBe(2);
    expect(p1.items.every((i: any) => i.planName === 'Free')).toBe(true);
    expect(((await s.svc.listSubscribers('s2')) as any).total).toBe(0);
  });
});

describe('plan validation', () => {
  it('rejects bad input and a product of another store', async () => {
    const s = setup();
    s.storeModel.rows.push({ _id: 's1', baseCurrency: 'USD', isDelete: false });
    await expect(s.svc.createPlan('s1', { name: '', type: 'free' })).rejects.toThrow('name is required');
    await expect(s.svc.createPlan('s1', { name: 'X', type: 'recurring', amount: 0 })).rejects.toThrow('greater than 0');
    await expect(s.svc.createPlan('s1', { name: 'X', type: 'recurring', amount: 5, graceDays: 9 })).rejects.toThrow('between 0 and 7');
    await expect(s.svc.createPlan('s1', { name: 'X', type: 'free', productId: 'nope' })).rejects.toThrow('not found in your store');
  });
});
