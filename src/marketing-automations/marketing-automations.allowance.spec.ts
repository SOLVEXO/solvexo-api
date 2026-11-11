import { MarketingAutomationsService } from './marketing-automations.service';
import { EntitlementsService } from '../platform-plans/entitlements.service';
import { FakeModel } from '../digital-access/testing/fake-db.kit-spec';

/** Automation emails count against the plan's monthly marketing emails, and a plan without marketing emails sends none. */

function build(room: number | ((storeId: string) => number)) {
  const m = {
    storeModel: new FakeModel(), marketingAutomationSettingsModel: new FakeModel(), automationSendLogModel: new FakeModel(),
    backInStockRequestModel: new FakeModel(), productVariantModel: new FakeModel(), productModel: new FakeModel(),
    orderModel: new FakeModel(), userModel: new FakeModel(), newsletterSubscriberModel: new FakeModel(),
  };
  (m.automationSendLogModel as any).unique = ['storeId', 'type', 'email', 'refKey'];
  m.storeModel.rows.push({ _id: 's1', name: 'Shop One', slug: 'shop-one', isDelete: false, contactEmail: null, baseCurrency: 'USD' });
  const sent: string[] = [];
  const email: any = { sendMail: async (to: string) => { sent.push(to); return true; } };
  const ent: any = {
    getEmailRoom: async (storeId: string) => (typeof room === 'function' ? room(storeId) : room),
    assertFeatureAllowed: async () => undefined, // the plan feature switch is on; the allowance is what these tests vary
  };
  const svc = new MarketingAutomationsService({ repositories: m } as any, email, ent);
  return { svc, m, sent };
}

describe('welcome email and the plan allowance', () => {
  it('is not sent when the plan has no marketing emails left', async () => {
    const { svc, sent } = build(0);
    expect(await svc.sendWelcome('s1', 'a@x.com', 'tok')).toBe(false);
    expect(sent.length).toBe(0);
  });
  it('is sent when there is room', async () => {
    const { svc, sent } = build(5);
    expect(await svc.sendWelcome('s1', 'a@x.com', 'tok')).toBe(true);
    expect(sent).toEqual(['a@x.com']);
  });
});

describe('back in stock and the plan allowance', () => {
  function stock(room: number, requests: number) {
    const k = build(room);
    k.m.productModel.rows.push({ _id: 'p1', storeId: 's1', name: 'Mug', slug: 'mug', images: [], status: 'active', isDelete: false });
    k.m.productVariantModel.rows.push({ _id: 'v1', productId: 'p1', status: 'active', stock: 5, price: 10, options: [] });
    for (let i = 0; i < requests; i++) k.m.backInStockRequestModel.rows.push({ _id: `r${i}`, storeId: 's1', productId: 'p1', variantId: 'v1', email: `u${i}@x.com`, status: 'pending' });
    return k;
  }
  it('mails only as many people as there is room for; the rest stay waiting', async () => {
    const k = stock(2, 4);
    expect((await k.svc.processBackInStock()).notified).toBe(2);
    expect(k.m.backInStockRequestModel.rows.filter((r: any) => r.status === 'pending').length).toBe(2);
  });
  it('with no room nobody is mailed and every request stays pending', async () => {
    const k = stock(0, 3);
    expect((await k.svc.processBackInStock()).notified).toBe(0);
    expect(k.m.backInStockRequestModel.rows.every((r: any) => r.status === 'pending')).toBe(true);
    expect(k.sent.length).toBe(0);
  });
  it('the next run (a new month, more room) finishes the waiting list', async () => {
    const k = stock(2, 4);
    await k.svc.processBackInStock();
    (k.svc as any).entitlementsService.getEmailRoom = async () => 10;
    expect((await k.svc.processBackInStock()).notified).toBe(2);
    expect(k.m.backInStockRequestModel.rows.every((r: any) => r.status === 'notified')).toBe(true);
  });
});

// real-looking ids: the service ignores ids that are not valid ObjectIds
const oid = (i: number) => i.toString(16).padStart(24, '0');

describe('win-back reaches customers beyond the first 500', () => {
  function winBack(room: number, lapsedCount: number) {
    const k = build(room);
    k.m.marketingAutomationSettingsModel.rows.push({ storeId: 's1', winBack: { enabled: true, afterDays: 30, subject: 'We miss you', message: 'Come back' } });
    const lapsed = Array.from({ length: lapsedCount }, (_, i) => ({ _id: oid(i), lastOrderAt: new Date(2026, 0, 1 + (i % 28)) }));
    (k.m.orderModel as any).aggregate = async (pipeline: any[]) => {
      const skip = pipeline.find((st) => '$skip' in st)?.$skip ?? 0;
      const limit = pipeline.find((st) => '$limit' in st)?.$limit ?? lapsed.length;
      return lapsed.slice(skip, skip + limit);
    };
    for (let i = 0; i < lapsedCount; i++) {
      k.m.userModel.rows.push({ _id: oid(i), name: `U${i}`, email: `u${i}@x.com`, isDelete: false });
      k.m.newsletterSubscriberModel.rows.push({ storeId: 's1', email: `u${i}@x.com`, isActive: true, unsubscribeToken: `t${i}` });
    }
    return k;
  }
  it('works through a second page when the first page is already mailed', async () => {
    const k = winBack(100000, 520);
    // the first 500 were mailed on earlier runs
    for (let i = 0; i < 500; i++) {
      const at = new Date(2026, 0, 1 + (i % 28)).toISOString();
      k.m.automationSendLogModel.rows.push({ storeId: 's1', type: 'win_back', email: `u${i}@x.com`, refKey: `last:${at}`, delivered: true });
    }
    const r = await k.svc.processWinBack();
    expect(r.notified).toBe(20);
    expect(k.sent.length).toBe(20);
  });
  it('stops when the plan allowance runs out', async () => {
    const k = winBack(3, 10);
    expect((await k.svc.processWinBack()).notified).toBe(3);
  });
  it('sends nothing for a plan without marketing emails', async () => {
    const k = winBack(0, 10);
    expect((await k.svc.processWinBack()).notified).toBe(0);
  });
});

describe('the monthly marketing email count', () => {
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  function counted(over: { campaigns?: number; automations?: number; undelivered?: number; abandoned?: number; oldMonth?: number; otherStore?: number } = {}) {
    const campaignSends = new FakeModel(); const logs = new FakeModel(); const checkouts = new FakeModel();
    const now = new Date();
    for (let i = 0; i < (over.campaigns ?? 0); i++) campaignSends.rows.push({ storeId: 's1', createdAt: now });
    for (let i = 0; i < (over.automations ?? 0); i++) logs.rows.push({ storeId: 's1', delivered: true, createdAt: now });
    for (let i = 0; i < (over.undelivered ?? 0); i++) logs.rows.push({ storeId: 's1', delivered: false, createdAt: now });
    for (let i = 0; i < (over.abandoned ?? 0); i++) checkouts.rows.push({ abandonedEmailStoreId: 's1', abandonedEmailSentAt: now });
    for (let i = 0; i < (over.oldMonth ?? 0); i++) logs.rows.push({ storeId: 's1', delivered: true, createdAt: new Date(monthStart.getTime() - 86_400_000) });
    for (let i = 0; i < (over.otherStore ?? 0); i++) logs.rows.push({ storeId: 's2', delivered: true, createdAt: now });
    const db: any = { repositories: { emailCampaignSendModel: campaignSends, automationSendLogModel: logs, checkoutModel: checkouts } };
    const svc: any = new EntitlementsService(db);
    svc.getLimits = async () => ({ emailCampaignsAllowed: true, abandonedCartRecoveryAllowed: true, monthlyEmailSends: 10 });
    return svc as EntitlementsService;
  }
  it('adds campaigns, delivered automation mails and abandoned-cart reminders of this month', async () => {
    expect(await counted({ campaigns: 2, automations: 3, abandoned: 4 }).getMonthlyEmailUsage('s1')).toBe(9);
  });
  it('does not count undelivered ones, last month, or another store', async () => {
    expect(await counted({ automations: 1, undelivered: 5, oldMonth: 5, otherStore: 5 }).getMonthlyEmailUsage('s1')).toBe(1);
  });
  it('room is the allowance minus what was used, never below zero', async () => {
    expect(await counted({ automations: 4 }).getEmailRoom('s1')).toBe(6);
    expect(await counted({ automations: 12 }).getEmailRoom('s1')).toBe(0);
  });
  it('a plan without the feature has no room at all', async () => {
    const svc: any = counted();
    svc.getLimits = async () => ({ emailCampaignsAllowed: false, abandonedCartRecoveryAllowed: true, monthlyEmailSends: 10 });
    expect(await svc.getEmailRoom('s1')).toBe(0);
    expect(await svc.getEmailRoom('s1', 'abandonedCartRecoveryAllowed')).toBe(10);
  });
});
