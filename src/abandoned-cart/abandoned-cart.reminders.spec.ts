process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
import { AbandonedCartService } from './abandoned-cart.service';
import { FakeModel } from '../digital-access/testing/fake-db.kit-spec';

/** First reminder (discount code, plan allowance, unsubscribe) and the optional second reminder. */

const HOUR = 3_600_000;
const oid = (i: number) => i.toString(16).padStart(24, '0');

function setup(opts: { room?: number; settings?: any; allowed?: boolean } = {}) {
  const m = {
    checkoutModel: new FakeModel(), storeModel: new FakeModel(), userModel: new FakeModel(), couponModel: new FakeModel(),
    abandonedCartSettingsModel: new FakeModel(), newsletterSubscriberModel: new FakeModel(),
  };
  m.storeModel.rows.push({ _id: 's1', name: 'Shop One', contactEmail: null, isDelete: false });
  m.userModel.rows.push({ _id: 'u1', name: 'Sana', email: 'sana@x.com', isDelete: false });
  if (opts.settings) m.abandonedCartSettingsModel.rows.push({ storeId: 's1', isDelete: false, ...opts.settings });
  const sent: { to: string; subject: string; html: string; headers: any }[] = [];
  const email: any = { sendMail: async (to: string, subject: string, html: string, _r: any, headers: any) => { sent.push({ to, subject, html, headers }); return true; } };
  const ent: any = {
    getLimits: async () => ({ abandonedCartRecoveryAllowed: opts.allowed !== false }),
    getEmailRoom: async () => (opts.room ?? 100),
    assertFeatureAllowed: async () => undefined,
  };
  const svc = new AbandonedCartService({ repositories: m } as any, { log: () => undefined } as any, email, ent);
  return { svc, m, sent };
}

const cart = (over: any = {}) => ({
  _id: oid(1), userId: 'u1', status: 'pending', isDelete: false, recoveredAt: null, items: [{ storeId: 's1', quantity: 1 }],
  abandonedEmailSentAt: null, abandonedSecondEmailSentAt: null, abandonedEmailSuppressedAt: null, abandonedRecoveryToken: null, abandonedEmailStoreId: null,
  updatedAt: new Date(Date.now() - 2 * HOUR), ...over,
});

describe('first reminder', () => {
  it('has no discount block when the seller set no code', async () => {
    const k = setup();
    k.m.checkoutModel.rows.push(cart());
    await k.svc.processAbandonedCarts();
    expect(k.sent.length).toBe(1);
    expect(k.sent[0].html.includes('Your code')).toBe(false);
  });
  it('shows the discount code when the seller set one', async () => {
    const k = setup({ settings: { enabled: true, delayMinutes: 5, subject: 'Hi', message: 'Back to your cart {{cartUrl}}', discountCode: 'SAVE10' } });
    k.m.checkoutModel.rows.push(cart());
    await k.svc.processAbandonedCarts();
    expect(k.sent[0].html.includes('SAVE10')).toBe(true);
    expect(k.sent[0].html.includes('Your code')).toBe(true);
  });
  it('carries an unsubscribe link and the one-click header', async () => {
    const k = setup();
    k.m.checkoutModel.rows.push(cart());
    await k.svc.processAbandonedCarts();
    expect(k.sent[0].html.includes('/api/abandoned-cart/unsubscribe/')).toBe(true);
    expect(String(k.sent[0].headers?.['List-Unsubscribe'] ?? '').includes('/api/abandoned-cart/unsubscribe/')).toBe(true);
  });
  it('is not sent when the plan allowance is used up; the checkout stays untouched for a later run', async () => {
    const k = setup({ room: 0 });
    k.m.checkoutModel.rows.push(cart());
    await k.svc.processAbandonedCarts();
    expect(k.sent.length).toBe(0);
    expect(k.m.checkoutModel.rows[0].abandonedEmailSentAt).toBeNull();
  });
  it('remembers which store the mail counts against', async () => {
    const k = setup();
    k.m.checkoutModel.rows.push(cart());
    await k.svc.processAbandonedCarts();
    expect(k.m.checkoutModel.rows[0].abandonedEmailStoreId).toBe('s1');
  });
  it('is not sent to someone who unsubscribed', async () => {
    const k = setup();
    k.m.newsletterSubscriberModel.rows.push({ storeId: 's1', email: 'sana@x.com', isActive: false });
    k.m.checkoutModel.rows.push(cart());
    await k.svc.processAbandonedCarts();
    expect(k.sent.length).toBe(0);
  });
});

describe('second reminder', () => {
  const on = { enabled: true, delayMinutes: 5, subject: 'Hi', message: 'Back {{cartUrl}}', secondReminderEnabled: true, secondReminderDelayHours: 24, secondSubject: 'Still thinking?', secondMessage: 'Last reminder {{cartUrl}}', discountCode: 'SAVE10' };
  const firstSent = (hoursAgo: number, over: any = {}) => cart({ abandonedEmailSentAt: new Date(Date.now() - hoursAgo * HOUR), abandonedRecoveryToken: 'tok1', abandonedEmailStoreId: 's1', ...over });

  it('goes out once, after the delay, with its own subject, the code and the same click token', async () => {
    const k = setup({ settings: on });
    k.m.checkoutModel.rows.push(firstSent(30));
    expect(await k.svc.processSecondReminders()).toBe(1);
    expect(k.sent[0].subject).toBe('Still thinking?');
    expect(k.sent[0].html.includes('SAVE10')).toBe(true);
    expect(k.sent[0].html.includes('/click/tok1')).toBe(true);
    expect(await k.svc.processSecondReminders()).toBe(0); // never a third mail
    expect(k.sent.length).toBe(1);
  });
  it('waits until the delay has passed', async () => {
    const k = setup({ settings: on });
    k.m.checkoutModel.rows.push(firstSent(10));
    expect(await k.svc.processSecondReminders()).toBe(0);
  });
  it('is off by default', async () => {
    const k = setup();
    k.m.checkoutModel.rows.push(firstSent(30));
    expect(await k.svc.processSecondReminders()).toBe(0);
  });
  it('is not sent once the shopper ordered', async () => {
    const k = setup({ settings: on });
    k.m.checkoutModel.rows.push(firstSent(30, { status: 'completed' }));
    k.m.checkoutModel.rows.push(firstSent(30, { _id: oid(2), recoveredAt: new Date() }));
    expect(await k.svc.processSecondReminders()).toBe(0);
  });
  it('is not sent to someone who unsubscribed after the first mail', async () => {
    const k = setup({ settings: on });
    k.m.newsletterSubscriberModel.rows.push({ storeId: 's1', email: 'sana@x.com', isActive: false });
    k.m.checkoutModel.rows.push(firstSent(30));
    expect(await k.svc.processSecondReminders()).toBe(0);
  });
  it('respects the plan allowance', async () => {
    const k = setup({ settings: on, room: 0 });
    k.m.checkoutModel.rows.push(firstSent(30));
    expect(await k.svc.processSecondReminders()).toBe(0);
    expect(k.m.checkoutModel.rows[0].abandonedSecondEmailSentAt).toBeNull();
  });
  it('stops when the plan no longer includes recovery', async () => {
    const k = setup({ settings: on, allowed: false });
    k.m.checkoutModel.rows.push(firstSent(30));
    expect(await k.svc.processSecondReminders()).toBe(0);
  });
  it('a failed send releases the claim so the next run retries', async () => {
    const k = setup({ settings: on });
    (k.svc as any).emailService.sendMail = async () => false;
    k.m.checkoutModel.rows.push(firstSent(30));
    expect(await k.svc.processSecondReminders()).toBe(0);
    expect(k.m.checkoutModel.rows[0].abandonedSecondEmailSentAt).toBeNull();
  });
  it('mails that were sent before this feature existed (no store recorded) get no second mail', async () => {
    const k = setup({ settings: on });
    k.m.checkoutModel.rows.push(firstSent(30, { abandonedEmailStoreId: null }));
    expect(await k.svc.processSecondReminders()).toBe(0);
  });
});

describe('settings: discount code', () => {
  it('accepts a real coupon of the store (case-insensitive) and stores it upper case', async () => {
    const k = setup();
    k.m.storeModel.rows[0].sellerId = 'sel1';
    k.m.couponModel.rows.push({ storeId: 's1', code: 'SAVE10', isDelete: false });
    (k.svc as any).verifyStoreOwnership = async () => ({});
    const r: any = await k.svc.updateSettings('sel1', 's1', { discountCode: 'save10' } as any);
    expect(r.data.discountCode).toBe('SAVE10');
  });
  it('rejects a code that does not exist in this store, and another store\'s code', async () => {
    const k = setup();
    k.m.couponModel.rows.push({ storeId: 's2', code: 'THEIRS', isDelete: false });
    (k.svc as any).verifyStoreOwnership = async () => ({});
    await expect(k.svc.updateSettings('sel1', 's1', { discountCode: 'NOPE' } as any)).rejects.toThrow();
    await expect(k.svc.updateSettings('sel1', 's1', { discountCode: 'THEIRS' } as any)).rejects.toThrow();
  });
  it('an empty string removes the code', async () => {
    const k = setup();
    (k.svc as any).verifyStoreOwnership = async () => ({});
    const r: any = await k.svc.updateSettings('sel1', 's1', { discountCode: '' } as any);
    expect(r.data.discountCode).toBeNull();
  });
});
