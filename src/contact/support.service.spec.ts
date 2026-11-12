import { ForbiddenException } from '@nestjs/common';
import { SupportService, MAX_OPEN_REQUESTS_PER_STORE } from './support.service';
import { ContactService } from './contact.service';
import { sortSubmissions, tierFromLimits } from './support.util';
import { CreateSupportRequestDto } from './dto/support.dto';
import { FakeModel } from './../digital-access/testing/fake-db.kit-spec';

function make(limits: any = {}) {
  const contact = new FakeModel({ status: 'new', source: 'public', tier: 'standard' });
  const store = new FakeModel();
  const seller = new FakeModel();
  store.rows.push({ _id: 's1', sellerId: 'seller1', isDelete: false, name: 'Shop One' });
  store.rows.push({ _id: 's2', sellerId: 'seller2', isDelete: false, name: 'Shop Two' });
  seller.rows.push({ _id: 'seller1', name: 'Owner', email: 'owner@x.com' });
  const db: any = { repositories: { storeModel: store, sellerModel: seller } };
  const entitlements: any = { getLimits: async () => limits };
  const notifications: any = { notifyAdmins: jest.fn().mockResolvedValue(1), notify: jest.fn().mockResolvedValue(undefined) };
  const email: any = { sendMail: jest.fn().mockResolvedValue(true) };
  const support = new SupportService(contact as any, db, entitlements, notifications);
  const admin = new ContactService(contact as any, email, notifications, undefined, db);
  return { support, admin, contact, notifications, email };
}

const dto = (over: Partial<CreateSupportRequestDto> = {}): CreateSupportRequestDto => ({ category: 'payments', subject: 'Payout late', message: 'Where is it', ...over });
const owner = { userId: 'seller1', role: 'seller', email: 'owner@x.com' };

describe('support tier', () => {
  it('maps the plan limits to a tier', () => {
    expect(tierFromLimits({ prioritySupport: false, dedicatedAccountManager: false })).toBe('standard');
    expect(tierFromLimits({ prioritySupport: true, dedicatedAccountManager: false })).toBe('priority');
    expect(tierFromLimits({ prioritySupport: true, dedicatedAccountManager: true })).toBe('dedicated');
    expect(tierFromLimits(null)).toBe('standard');
  });

  it('stamps the tier from the plan on the server for all three cases', async () => {
    for (const [limits, tier] of [
      [{ prioritySupport: false, dedicatedAccountManager: false }, 'standard'],
      [{ prioritySupport: true, dedicatedAccountManager: false }, 'priority'],
      [{ prioritySupport: true, dedicatedAccountManager: true }, 'dedicated'],
    ] as const) {
      const { support, contact, notifications } = make(limits);
      const res = await support.create('s1', owner, 'seller1', dto());
      expect(res.data.tier).toBe(tier);
      expect(contact.rows[0].tier).toBe(tier);
      expect(contact.rows[0].source).toBe('seller');
      expect(contact.rows[0].storeId).toBe('s1');
      expect(notifications.notifyAdmins.mock.calls.length).toBe(1);
    }
  });

  it('never takes the tier from the body: the DTO has no tier field and the service ignores extras', async () => {
    const { support, contact } = make({ prioritySupport: false });
    await support.create('s1', owner, 'seller1', { ...dto(), tier: 'dedicated', source: 'public', storeId: 's2' } as any);
    expect(contact.rows[0].tier).toBe('standard');
    expect(contact.rows[0].source).toBe('seller');
    expect(contact.rows[0].storeId).toBe('s1');
  });
});

describe('store pinning', () => {
  it("refuses another seller's store (create and list)", async () => {
    const { support, contact } = make();
    const denied = async (p: Promise<unknown>) => p.then(() => false, (e) => e instanceof ForbiddenException);
    expect(await denied(support.create('s2', owner, 'seller1', dto()))).toBe(true);
    expect(await denied(support.list('s2', 'seller1', {}))).toBe(true);
    expect(contact.rows.length).toBe(0);
  });

  it('lists only the own store requests and never other stores or the public form', async () => {
    const { support, contact } = make();
    await support.create('s1', owner, 'seller1', dto());
    contact.rows.push({ _id: 'x', topic: 'public', message: 'm', source: 'public', status: 'new' });
    contact.rows.push({ _id: 'y', topic: 'other store', message: 'm', source: 'seller', storeId: 's2', status: 'new' });
    const res = await support.list('s1', 'seller1', {});
    expect(res.total).toBe(1);
    expect(res.items[0].subject).toBe('Payout late');
    expect('email' in (res.items[0] as any)).toBe(false);
  });

  it('caps open requests per store', async () => {
    const { support, contact } = make();
    for (let i = 0; i < MAX_OPEN_REQUESTS_PER_STORE; i++) contact.rows.push({ _id: `o${i}`, source: 'seller', storeId: 's1', status: 'new' });
    await expect(support.create('s1', owner, 'seller1', dto())).rejects.toThrow();
  });
});

describe('admin inbox order', () => {
  const d = (n: number) => new Date(2026, 0, n);

  it('open first by tier then oldest first, resolved last', () => {
    const rows = [
      { id: 'std-old', status: 'new', tier: 'standard', createdAt: d(1) },
      { id: 'pri-new', status: 'new', tier: 'priority', createdAt: d(5) },
      { id: 'ded-new', status: 'read', tier: 'dedicated', createdAt: d(6) },
      { id: 'pri-old', status: 'new', tier: 'priority', createdAt: d(2) },
      { id: 'ded-resolved', status: 'resolved', tier: 'dedicated', createdAt: d(1) },
      { id: 'legacy', status: 'new', createdAt: d(3) },
    ];
    expect(sortSubmissions(rows).map((r) => r.id)).toEqual(['ded-new', 'pri-old', 'pri-new', 'std-old', 'legacy', 'ded-resolved']);
  });

  it('findAll sorts, filters by tier/source and adds the store name', async () => {
    const { admin, contact } = make();
    contact.rows.push(
      { _id: 'a', name: 'A', email: 'a@x.com', topic: 't', message: 'm', status: 'new', source: 'public', tier: 'standard', createdAt: d(1) },
      { _id: 'b', name: 'B', email: 'b@x.com', topic: 't', message: 'm', status: 'new', source: 'seller', tier: 'priority', storeId: 's1', createdAt: d(3) },
      { _id: 'c', name: 'C', email: 'c@x.com', topic: 't', message: 'm', status: 'new', source: 'seller', tier: 'dedicated', storeId: 's2', createdAt: d(4) },
    );
    const all = await admin.findAll();
    expect(all.data.map((r: any) => r._id)).toEqual(['c', 'b', 'a']);
    expect(all.data[1].storeName).toBe('Shop One');
    expect(all.stats.new).toBe(3);
    const pri = await admin.findAll({ tier: 'priority' });
    expect(pri.data.map((r: any) => r._id)).toEqual(['b']);
    const pub = await admin.findAll({ source: 'public' });
    expect(pub.data.map((r: any) => r._id)).toEqual(['a']);
  });
});

describe('admin reply', () => {
  it('emails the requester, keeps the reply and notifies the seller of a seller request', async () => {
    const { support, admin, contact, email, notifications } = make({ prioritySupport: true });
    await support.create('s1', owner, 'seller1', dto());
    const id = contact.rows[0]._id;
    const res = await admin.reply(id, 'We fixed it', 'Admin');
    expect(email.sendMail.mock.calls[0][0]).toBe('owner@x.com');
    expect(res.data!.replies.length).toBe(1);
    expect(res.data!.status).toBe('read');
    const n = notifications.notify.mock.calls[0][0];
    expect([n.recipientId, n.recipientRole, n.type, n.storeId]).toEqual(['seller1', 'seller', 'support_reply', 's1']);
    const mine = await support.list('s1', 'seller1', {});
    expect(mine.items[0].replies[0].message).toBe('We fixed it');
  });

  it('does not notify a seller for a public form message', async () => {
    const { admin, contact, notifications } = make();
    contact.rows.push({ _id: 'p', name: 'A', email: 'a@x.com', topic: 't', message: 'm', status: 'new', source: 'public', tier: 'standard' });
    await admin.reply('p', 'hi', 'Admin');
    expect(notifications.notify.mock.calls.length).toBe(0);
  });
});
