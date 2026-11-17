/* eslint-disable prettier/prettier */
import { SalesOpsService } from './sales-ops.service';
import { SalesVisitsService } from './sales-visits.service';
import { salesActor } from './sales-ops.util';
import { model } from './sales-ops.fakes.testspec';

const MANAGER = salesActor({ userId: 'a'.repeat(24) });
const REP = salesActor({ userId: 'b'.repeat(24), teamAdmin: true, permissions: ['sales.access'] });
const OTHER_REP = salesActor({ userId: 'c'.repeat(24), teamAdmin: true, permissions: ['sales.access'] });
const NOW = new Date('2026-11-17T11:00:00.000Z');
const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');

function setup() {
  const repos: any = {
    adminModel: model([
      { _id: MANAGER.adminId, name: 'Atiq' },
      { _id: REP.adminId, name: 'Ali Raza' },
      { _id: OTHER_REP.adminId, name: 'Hira Khan' },
    ]),
    adminRoleModel: model([]),
    sellerModel: model([]),
    storeModel: model([]),
    sellerPlatformSubscriptionModel: model([]),
  };
  const leads = model(), activities = model(), tasks = model(), templates = model(), visits = model();
  const sales = new SalesOpsService(
    { repositories: repos } as any,
    { withLock: jest.fn(async (_k: string, _t: number, fn: () => Promise<void>) => fn()) } as any,
    { sendMail: jest.fn(async () => true) } as any,
    leads as any, activities as any, tasks as any, templates as any,
  );
  const upload = { uploadFile: jest.fn(async () => ({ url: 'https://img.example/shop.png', publicId: 'sales/visits/x', resourceType: 'image' })) };
  const svc = new SalesVisitsService({ repositories: repos } as any, sales, upload as any, visits as any, leads as any, tasks as any);
  return { svc, leads, activities, tasks, visits, upload };
}

const base = (over: Record<string, unknown> = {}) => ({
  clientId: 'v-' + Math.random().toString(36).slice(2),
  storeName: 'Zainab Collection',
  unit: 'Shop 14',
  floor: 'first',
  area: 'Tariq Road · Karachi',
  category: 'clothing',
  contactName: 'Imran Sheikh',
  contactRole: 'owner',
  whatsapp: '0300 1234567',
  waPermission: true,
  sellsOn: ['shop', 'instagram'],
  payments: ['cod', 'easypaisa'],
  problem: 'Stock ka pata nahi chalta',
  objections: ['ask_partner'],
  interest: 'hot',
  nextStep: 'demo',
  nextStepAt: '2026-11-20T10:00:00.000Z',
  visitedAt: '2026-11-17T10:30:00.000Z',
  ...over,
});

describe('SalesVisitsService', () => {
  it('creates a lead from a first visit, logs the answers, moves it to Contacted and books the follow-up', async () => {
    const { svc, leads, activities, tasks } = setup();
    const r = await svc.create(REP, base() as any, NOW);
    const lead: any = await leads.findOne({ _id: r.data.leadId });
    expect(lead).toMatchObject({ name: 'Imran Sheikh', businessName: 'Zainab Collection', source: 'field_visit', ownerAdminId: REP.adminId, stage: 'contacted', phoneKey: '3001234567' });
    expect(lead.tags).toEqual(['hot']);
    const log: any[] = await activities.find({ leadId: r.data.leadId, type: 'visit' });
    expect(log).toHaveLength(1);
    expect(log[0].body).toContain('Biggest problem: “Stock ka pata nahi chalta”');
    expect(log[0].body).toContain('Objections: Need to ask partner');
    const t: any[] = await tasks.find({ leadId: r.data.leadId });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ title: 'Demo — Zainab Collection', assigneeAdminId: REP.adminId });
    expect(lead.nextFollowUpAt).toEqual(new Date('2026-11-20T10:00:00.000Z'));
    expect(r.data.visit).toMatchObject({ adminName: 'Ali Raza', interest: 'hot', taskId: String(t[0]._id) });
  });

  it('stores a visit synced twice (offline retry) only once', async () => {
    const { svc, visits, tasks } = setup();
    const input = base({ clientId: 'phone-uuid-1' });
    const a = await svc.create(REP, input as any, NOW);
    const b = await svc.create(REP, input as any, NOW);
    expect(b.data.alreadySaved).toBe(true);
    expect(b.data.visit._id).toBe(a.data.visit._id);
    expect(await visits.find({})).toHaveLength(1);
    expect(await tasks.find({})).toHaveLength(1);
  });

  it('refuses another rep reusing a visit id', async () => {
    const { svc } = setup();
    await svc.create(REP, base({ clientId: 'same-id' }) as any, NOW);
    await expect(svc.create(OTHER_REP, base({ clientId: 'same-id' }) as any, NOW)).rejects.toThrow('already used');
  });

  it('joins a later visit with the same WhatsApp number to the same lead and hands the follow-up to its owner', async () => {
    const { svc, leads, tasks } = setup();
    const first = await svc.create(REP, base() as any, NOW);
    const second = await svc.create(OTHER_REP, base({ whatsapp: '+92 300 1234567', interest: 'warm', nextStep: 'send_price' }) as any, NOW);
    expect(second.data.leadId).toBe(first.data.leadId);
    expect(await leads.find({})).toHaveLength(1);
    const lead: any = await leads.findOne({ _id: first.data.leadId });
    expect(lead.tags).toEqual(['warm']);
    const t: any[] = await tasks.find({ leadId: first.data.leadId });
    expect(t.map((x) => x.assigneeAdminId)).toEqual([REP.adminId, REP.adminId]);
    expect(second.data.followUpOwner).toBe('Ali Raza');
  });

  it('closes an open lead as Lost when the shop is not interested, with no follow-up for "None"', async () => {
    const { svc, leads, tasks } = setup();
    const r = await svc.create(REP, base({ interest: 'not_interested', nextStep: 'none', nextStepAt: null }) as any, NOW);
    const lead: any = await leads.findOne({ _id: r.data.leadId });
    expect(lead.stage).toBe('lost');
    expect(lead.lostReason).toBe('not_a_fit');
    expect(await tasks.find({})).toHaveLength(0);
  });

  it('requires a store name and a date for any next step', async () => {
    const { svc } = setup();
    await expect(svc.create(REP, base({ storeName: '  ' }) as any, NOW)).rejects.toThrow('store name');
    await expect(svc.create(REP, base({ nextStepAt: null }) as any, NOW)).rejects.toThrow('date for the next step');
  });

  it('keeps a phone clock in the future or months back from mis-dating the visit', async () => {
    const { svc } = setup();
    const future = await svc.create(REP, base({ visitedAt: '2027-01-01T00:00:00.000Z' }) as any, NOW);
    expect(new Date(future.data.visit.visitedAt)).toEqual(NOW);
    const offline = await svc.create(REP, base({ clientId: 'x2', whatsapp: '0311 0000000', visitedAt: '2026-11-15T09:00:00.000Z' }) as any, NOW);
    expect(new Date(offline.data.visit.visitedAt)).toEqual(new Date('2026-11-15T09:00:00.000Z'));
  });

  it('uploads the shop photo, rejects a fake one, and still saves the visit when the upload service is down', async () => {
    const { svc, upload } = setup();
    const ok = await svc.create(REP, base({ photoDataUrl: PNG }) as any, NOW);
    expect(ok.data.visit.photoUrl).toBe('https://img.example/shop.png');
    expect(upload.uploadFile).toHaveBeenCalledWith(expect.objectContaining({ mimetype: 'image/png' }), { folder: 'sales/visits', maxDimension: 1600 });
    await expect(svc.create(REP, base({ clientId: 'bad', photoDataUrl: 'data:image/png;base64,' + Buffer.from('<svg/>').toString('base64') }) as any, NOW)).rejects.toThrow();
    upload.uploadFile.mockRejectedValueOnce(new Error('cloudinary down'));
    const down = await svc.create(REP, base({ clientId: 'down', whatsapp: '0333 1111111', photoDataUrl: PNG }) as any, NOW);
    expect(down.data.visit.photoUrl).toBeNull();
  });

  it('shows a rep only their own visits, and a manager everyone\'s, with totals', async () => {
    const { svc } = setup();
    await svc.create(REP, base() as any, NOW);
    await svc.create(OTHER_REP, base({ storeName: 'Glow Cosmetics', whatsapp: '0321 5555555', interest: 'warm', nextStep: 'signup' }) as any, NOW);
    const mine = await svc.list(REP, {});
    expect(mine.data.items.map((v: any) => v.storeName)).toEqual(['Zainab Collection']);
    const all = await svc.list(MANAGER, {});
    expect(all.data.total).toBe(2);
    expect(all.data.summary).toMatchObject({ visits: 2, shops: 2, hot: 1, demos: 1, signups: 1 });
    await expect(svc.get(REP, all.data.items.find((v: any) => v.storeName === 'Glow Cosmetics')._id)).rejects.toThrow('Visit not found');
  });

  it('warns about an earlier visit to the same number or the same shop name in the same area', async () => {
    const { svc } = setup();
    await svc.create(REP, base() as any, NOW);
    const byPhone = await svc.check('0300-1234567');
    expect(byPhone.data[0]).toMatchObject({ storeName: 'Zainab Collection', adminName: 'Ali Raza', samePhone: true, interest: 'hot' });
    const byName = await svc.check(undefined, '  zainab   COLLECTION ', 'Tariq Road · Karachi');
    expect(byName.data).toHaveLength(1);
    expect((await svc.check(undefined, 'Zainab Collection', 'Liberty · Lahore')).data).toHaveLength(0);
    expect((await svc.check('12', 'ab')).data).toHaveLength(0);
  });

  it('lets a rep correct their own visit answers', async () => {
    const { svc } = setup();
    const r = await svc.create(REP, base() as any, NOW);
    const fixed = await svc.update(REP, r.data.visit._id, { billing: 'software', billingSoftware: 'Moneypex', category: 'shoes', categoryOther: 'x' } as any);
    expect(fixed.data).toMatchObject({ billing: 'software', billingSoftware: 'Moneypex', category: 'shoes', categoryOther: null });
    await expect(svc.update(OTHER_REP, r.data.visit._id, { unit: 'Shop 1' } as any)).rejects.toThrow('Visit not found');
  });
});
