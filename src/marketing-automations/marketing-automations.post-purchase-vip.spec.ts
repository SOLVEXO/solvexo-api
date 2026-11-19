import { MarketingAutomationsService } from './marketing-automations.service';
import { FakeModel } from '../digital-access/testing/fake-db.kit-spec';

/** Post-purchase (a thank-you N days after an order) and customer appreciation (one email, once, to a VIP). */

const U1 = '000000000000000000000001';
const U2 = '000000000000000000000002';

function build(opts: { room?: number; orders?: any[]; vips?: any[]; settings: Record<string, any> }) {
  const m: any = {
    storeModel: new FakeModel(), marketingAutomationSettingsModel: new FakeModel(), automationSendLogModel: new FakeModel(),
    userModel: new FakeModel(), newsletterSubscriberModel: new FakeModel(), productModel: new FakeModel(), productVariantModel: new FakeModel(),
    // The real queries use $elemMatch / aggregation, which the in-memory model does not do: these return the rows a real database would.
    orderModel: {
      find: () => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => opts.orders ?? [] }) }) }) }),
      aggregate: jest.fn().mockResolvedValueOnce(opts.vips ?? []).mockResolvedValue([]),
    },
  };
  m.automationSendLogModel.unique = ['storeId', 'type', 'email', 'refKey'];
  m.storeModel.rows.push({ _id: 's1', name: 'Shop One', slug: 'shop-one', isDelete: false, contactEmail: null, baseCurrency: 'PKR', mailingAddress: '12 Main Street, Lahore' });
  m.userModel.rows.push({ _id: U1, name: 'Sana', email: 'sana@x.com', isDelete: false }, { _id: U2, name: 'Bilal', email: 'bilal@x.com', isDelete: false });
  m.newsletterSubscriberModel.rows.push({ storeId: 's1', email: 'sana@x.com', isActive: true, unsubscribeToken: 'tok1' });
  m.marketingAutomationSettingsModel.rows.push({ storeId: 's1', ...opts.settings });
  const sent: { to: string; subject: string; html: string }[] = [];
  const email: any = { sendMail: async (to: string, subject: string, html: string) => { sent.push({ to, subject, html }); return true; } };
  const ent: any = { getEmailRoom: async () => opts.room ?? 100, assertFeatureAllowed: async () => undefined };
  return { svc: new MarketingAutomationsService({ repositories: m } as any, email, ent), m, sent };
}

describe('post-purchase', () => {
  const on = { postPurchase: { enabled: true, afterDays: 3 } };
  const order = (over: any = {}) => ({ _id: 'o1', userId: U1, orderNumber: '1001', createdAt: new Date(), ...over });

  it('thanks a subscribed customer for the order, with the order number and the store address', async () => {
    const k = build({ settings: on, orders: [order()] });
    expect((await k.svc.processPostPurchase()).notified).toBe(1);
    expect(k.sent[0].to).toBe('sana@x.com');
    expect(k.sent[0].subject).toContain('Sana');
    expect(k.sent[0].html).toContain('#1001');
    expect(k.sent[0].html).toContain('12 Main Street, Lahore');
    expect(k.sent[0].html).toContain('/api/newsletter/unsubscribe/tok1');
  });

  it('never twice for the same order, even when the job runs again', async () => {
    const k = build({ settings: on, orders: [order()] });
    await k.svc.processPostPurchase();
    await k.svc.processPostPurchase();
    expect(k.sent.length).toBe(1);
  });

  it('a customer who is not subscribed to this store is not mailed', async () => {
    const k = build({ settings: on, orders: [order({ _id: 'o2', userId: U2 })] });
    expect((await k.svc.processPostPurchase()).notified).toBe(0);
    expect(k.sent.length).toBe(0);
  });

  it('an unsubscribed customer is not mailed', async () => {
    const k = build({ settings: on, orders: [order()] });
    k.m.newsletterSubscriberModel.rows[0].isActive = false;
    expect((await k.svc.processPostPurchase()).notified).toBe(0);
  });

  it('stops when the plan has no marketing emails left', async () => {
    const k = build({ settings: on, orders: [order()], room: 0 });
    expect((await k.svc.processPostPurchase()).notified).toBe(0);
  });

  it('does nothing while switched off (the default)', async () => {
    const k = build({ settings: { postPurchase: { enabled: false } }, orders: [order()] });
    expect((await k.svc.processPostPurchase()).notified).toBe(0);
  });
});

describe('customer appreciation (VIP)', () => {
  const on = { customerAppreciation: { enabled: true, minOrders: 3, minSpent: 1000 } };

  it('sends ONE thank-you to a customer who reached the order count and spend', async () => {
    const k = build({ settings: on, vips: [{ _id: U1 }] });
    expect((await k.svc.processCustomerAppreciation()).notified).toBe(1);
    expect(k.sent[0].to).toBe('sana@x.com');
    expect(k.sent[0].html).toContain('12 Main Street, Lahore');
  });

  it('never again to the same customer on later runs', async () => {
    const k = build({ settings: on, vips: [{ _id: U1 }] });
    await k.svc.processCustomerAppreciation();
    k.m.orderModel.aggregate = jest.fn().mockResolvedValueOnce([{ _id: U1 }]).mockResolvedValue([]);
    await k.svc.processCustomerAppreciation();
    expect(k.sent.length).toBe(1);
  });

  it('asks the database for customers with at least the set orders and spend, in the store currency', async () => {
    const k = build({ settings: on, vips: [] });
    await k.svc.processCustomerAppreciation();
    const pipeline = JSON.stringify(k.m.orderModel.aggregate.mock.calls[0][0]);
    expect(pipeline).toContain('"orderCount":{"$gte":3}');
    expect(pipeline).toContain('"spent":{"$gte":1000}');
    expect(pipeline).toContain('"PKR"');
  });

  it('a VIP who is not subscribed is not mailed', async () => {
    const k = build({ settings: on, vips: [{ _id: U2 }] });
    expect((await k.svc.processCustomerAppreciation()).notified).toBe(0);
  });

  it('does nothing while switched off (the default)', async () => {
    const k = build({ settings: { customerAppreciation: { enabled: false } }, vips: [{ _id: U1 }] });
    expect((await k.svc.processCustomerAppreciation()).notified).toBe(0);
  });
});

describe('test send for the new automations', () => {
  it.each(['postPurchase', 'customerAppreciation'])('%s sends a [Test] copy with sample data', async (section) => {
    const k = build({ settings: {} });
    await k.svc.sendTest('s1', section, 'owner@x.com');
    expect(k.sent[0].subject.startsWith('[Test]')).toBe(true);
    expect(k.sent[0].to).toBe('owner@x.com');
  });
});
