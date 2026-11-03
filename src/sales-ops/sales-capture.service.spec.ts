/* eslint-disable prettier/prettier */
import { SalesOpsService } from './sales-ops.service';
import { SalesCaptureService } from './sales-capture.service';
import { salesActor } from './sales-ops.util';
import { model } from './sales-ops.fakes.testspec';

const SUPER = salesActor({ userId: 'a'.repeat(24) });
const REP = salesActor({
  userId: 'b'.repeat(24),
  teamAdmin: true,
  permissions: ['sales.access'],
});
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(
  extra: { sellers?: any[]; stuck?: any[]; contacts?: any[] } = {},
) {
  const repos: any = {
    adminModel: model([
      {
        _id: SUPER.adminId,
        name: 'Atiq',
        isSuperAdmin: true,
        status: 'active',
      },
      { _id: REP.adminId, name: 'Bilal', roleId: 'r1', status: 'active' },
    ]),
    adminRoleModel: model([
      { _id: 'r1', isDelete: false, permissions: ['sales.access'] },
    ]),
    sellerModel: model(extra.sellers ?? []),
    storeModel: model([]),
    sellerPlatformSubscriptionModel: model([]),
  };
  const leads = model(),
    activities = model(),
    tasks = model(),
    templates = model(),
    contacts = model(extra.contacts ?? []);
  const email = { sendMail: jest.fn(async () => true) };
  const redis = {
    withLock: jest.fn(async (_k: string, _t: number, fn: () => Promise<void>) =>
      fn(),
    ),
  };
  const notifications = { notify: jest.fn(async () => undefined) };
  const funnel = { stuck: jest.fn(async () => extra.stuck ?? []) };
  const db = { repositories: repos } as any;
  const sales = new SalesOpsService(
    db,
    redis as any,
    email as any,
    leads as any,
    activities as any,
    tasks as any,
    templates as any,
  );
  const capture = new SalesCaptureService(
    db,
    redis as any,
    email as any,
    notifications as any,
    funnel as any,
    sales,
    leads as any,
    activities as any,
    contacts as any,
  );
  return { sales, capture, leads, activities, email, notifications, funnel };
}

describe('SalesCaptureService', () => {
  it('turns a demo request into a new, unassigned lead with its campaign, and tells managers only', async () => {
    const { capture, leads, activities, email, notifications } = setup();
    const r = await capture.demoRequest({
      name: 'Sara Malik',
      phone: '0300-111 2223',
      email: 'Sara@Example.com',
      businessName: 'Sara Boutique',
      city: 'Lahore',
      message: 'We sell clothes on Instagram.',
      preferredTime: 'Evening',
      utmSource: 'facebook',
      utmMedium: 'paid',
      utmCampaign: 'eid-sale',
    });
    expect(r.success).toBe(true);
    await flush();
    const lead = leads.rows[0];
    expect(lead).toMatchObject({
      name: 'Sara Malik',
      email: 'sara@example.com',
      phoneKey: '3001112223',
      source: 'website_form',
      stage: 'new',
      ownerAdminId: null,
      sourceDetail: 'Campaign: eid-sale',
      utm: { source: 'facebook', medium: 'paid', campaign: 'eid-sale' },
    });
    expect(activities.rows[0].body).toContain('We sell clothes on Instagram.');
    expect(activities.rows[0].body).toContain('Best time to call: Evening.');
    expect(email.sendMail).toHaveBeenCalledWith(
      'sara@example.com',
      expect.stringContaining('demo request'),
      expect.any(String),
    );
    // The Super Admin hears about it; a rep (sales.access only) does not.
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: SUPER.adminId,
        data: { link: `/admin/sales/leads/${lead._id}` },
      }),
    );
  });

  it('refuses a demo request without a usable phone number', async () => {
    const { capture } = setup();
    await expect(
      capture.demoRequest({ name: 'X', phone: '12' }),
    ).rejects.toThrow('phone number');
  });

  it('puts a returning person on their existing lead (matched by phone), fills blanks and reopens it if lost', async () => {
    const { capture, sales, leads, activities } = setup();
    const first = await sales.create(SUPER, {
      name: 'Hamza',
      phone: '03001112223',
    });
    await sales.changeStage(SUPER, first.data.lead._id, 'lost', 'timing');
    const r = await capture.demoRequest({
      name: 'Hamza Ali',
      phone: '+92 300 1112223',
      email: 'hamza@shop.example',
      businessName: 'Hamza Mart',
    });
    expect(r.success).toBe(true);
    expect(leads.rows).toHaveLength(1);
    expect(leads.rows[0]).toMatchObject({
      stage: 'new',
      email: 'hamza@shop.example',
      businessName: 'Hamza Mart',
      name: 'Hamza',
      lostReason: null,
    });
    expect(activities.rows.map((a: any) => a.body)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Got in touch again via Book-a-demo form'),
        expect.stringContaining('Reopened'),
      ]),
    );
  });

  it('imports new rows, reports duplicates (in the file and in the pipeline) and bad rows, and gives a rep their own leads', async () => {
    const { capture, sales, leads } = setup();
    const existing = await sales.create(SUPER, {
      name: 'Old',
      email: 'old@x.com',
    });
    const rows = [
      { name: 'Ayesha', email: 'ayesha@x.com', dealValuePKR: 'PKR 60,000' },
      { name: 'Ayesha again', email: 'AYESHA@x.com' },
      { name: 'Old one', email: 'old@x.com' },
      { name: '', phone: '0300 1234567' },
      { name: 'No reach' },
      { name: 'Usman', phone: '0321-7654321', note: 'Met at the expo' },
    ];
    const dry = await capture.importLeads(REP, rows, {}, true);
    expect(dry.data).toMatchObject({
      created: 0,
      wouldCreate: 2,
      dryRun: true,
    });
    expect(leads.rows).toHaveLength(1);

    const res = await capture.importLeads(REP, rows, {
      sourceDetail: 'Lahore expo',
    });
    expect(res.data.created).toBe(2);
    expect(res.data.duplicates).toEqual([
      { row: 3, name: 'Ayesha again', existingLeadId: null, inFile: true },
      { row: 4, name: 'Old one', existingLeadId: existing.data.lead._id },
    ]);
    expect(res.data.invalid).toEqual([
      { row: 5, reason: 'Missing name' },
      { row: 6, reason: 'Needs an email or a phone number' },
    ]);
    const ayesha = leads.rows.find((l: any) => l.name === 'Ayesha');
    expect(ayesha).toMatchObject({
      source: 'import',
      sourceDetail: 'Lahore expo',
      ownerAdminId: REP.adminId,
      dealValuePKR: 60000,
    });
    await expect(
      capture.importLeads(REP, rows, { ownerAdminId: SUPER.adminId }),
    ).rejects.toThrow('Only a sales manager');
  });

  it('adds stalled sign-ups once, linked to their account, and skips anyone already in the pipeline', async () => {
    const sellers = [
      {
        _id: 'c'.repeat(24),
        name: 'Nadia',
        email: 'nadia@shop.example',
        phone: '0333 0000001',
      },
      {
        _id: 'd'.repeat(24),
        name: 'Known',
        email: 'known@shop.example',
        phone: '0333 0000002',
      },
    ];
    const stuck = sellers.map((s) => ({
      sellerId: s._id,
      name: s.name,
      email: s.email,
      stuckAt: 'store',
      nextStep: 'product',
      daysStuck: 5,
      signedUpDaysAgo: 6,
    }));
    const { capture, sales, leads, notifications } = setup({ sellers, stuck });
    await sales.create(SUPER, { name: 'Known', phone: '+92 333 0000002' });
    const r = await capture.syncStalled();
    expect(r).toMatchObject({ checked: 2, added: 1 });
    const nadia = leads.rows.find((l: any) => l.name === 'Nadia');
    expect(nadia).toMatchObject({
      source: 'stalled_signup',
      sellerId: 'c'.repeat(24),
      sourceDetail: 'Stuck at “Created a store”',
    });
    expect((await capture.syncStalled()).added).toBe(0);
    await flush();
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '1 stalled sign-up added to the pipeline',
      }),
    );
  });

  it('adds a Contact Us message to the pipeline from Super Admin', async () => {
    const contacts = [
      {
        _id: 'e'.repeat(24),
        name: 'Zainab',
        email: 'zainab@x.com',
        topic: 'General question',
        message: 'Can I sell books?',
      },
    ];
    const { capture, leads } = setup({ contacts });
    const r = await capture.addContactToPipeline(REP, 'e'.repeat(24));
    expect(r.data).toMatchObject({ created: true, visible: true });
    expect(leads.rows[0]).toMatchObject({
      source: 'contact_message',
      sourceDetail: 'General question',
      ownerAdminId: REP.adminId,
    });
    const again = await capture.addContactToPipeline(SUPER, 'e'.repeat(24));
    expect(again.data.created).toBe(false);
  });
});
