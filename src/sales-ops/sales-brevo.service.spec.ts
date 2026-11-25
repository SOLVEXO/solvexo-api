/* eslint-disable prettier/prettier */
process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY =
  process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY || 'test-key-for-sales-brevo-spec-0123456789';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-sales-brevo-spec';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SalesOpsService } from './sales-ops.service';
import { SalesCaptureService } from './sales-capture.service';
import { SalesBrevoService } from './sales-brevo.service';
import { salesActor } from './sales-ops.util';
import { signConsentToken } from './sales-brevo.util';
import { model } from './sales-ops.fakes.testspec';

const SUPER = salesActor({ userId: 'a'.repeat(24) });
const KEY = 'xkeysib-0123456789abcdef-a1b2';
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
type Reply = { status?: number; json?: any };

function setup() {
  const repos: any = {
    adminModel: model([{ _id: SUPER.adminId, name: 'Atiq', isSuperAdmin: true, status: 'active' }]),
    adminRoleModel: model([]),
    sellerModel: model([]),
    storeModel: model([]),
    sellerPlatformSubscriptionModel: model([]),
  };
  const db = { repositories: repos } as any;
  const leads = model(), activities = model(), tasks = model(), templates = model(), contacts = model(), settings = model();
  const redis = { withLock: jest.fn(async (_k: string, _t: number, fn: () => Promise<void>) => { await fn(); return 'ran'; }) };
  const email = { sendMail: jest.fn(async () => true) };
  const notifications = { notify: jest.fn(async () => undefined) };
  const activityLog = { log: jest.fn(async () => undefined) };
  const sales = new SalesOpsService(db, redis as any, email as any, leads as any, activities as any, tasks as any, templates as any);
  const capture = new SalesCaptureService(db, redis as any, email as any, notifications as any, { stuck: async () => [] } as any, sales, leads as any, activities as any, contacts as any);
  const brevo = new SalesBrevoService(sales, redis as any, email as any, leads as any, settings as any, activityLog as any);

  const calls: { method: string; url: string; headers: any; body: any }[] = [];
  let reply: (method: string, path: string, body: any) => Reply = () => ({ status: 201, json: {} });
  brevo.fetchFn = (async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, url, headers: init.headers, body });
    const r = reply(init.method, url.replace('https://api.brevo.com/v3', ''), body);
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.json ?? {} };
  }) as any;
  return {
    sales, capture, brevo, leads, activities, settings, email, activityLog, calls,
    setReply: (f: typeof reply) => { reply = f; },
    async connect() {
      reply = (m, p) =>
        p === '/account' ? { json: { email: 'owner@solvexo.store', companyName: 'Solvexo' } }
          : p.startsWith('/contacts/attributes') ? { status: 201 }
            : p.startsWith('/contacts/folders?') ? { json: { folders: [{ id: 7, name: 'Solvexo' }], count: 1 } }
              : p.startsWith('/contacts/lists?') ? { json: { lists: [{ id: 42, name: 'Solvexo – Sales leads', folderId: 7 }], count: 1 } }
                : { status: 201 };
      await brevo.connect(KEY);
      calls.length = 0;
      reply = (m, p) => ({ status: p === '/contacts' ? 201 : 204 });
    },
  };
}

const lead = (over: Record<string, any> = {}) => ({
  name: 'Ayesha Khan', email: 'ayesha@example.com', phone: '03001234567', businessName: 'Khan Fabrics', city: 'Lahore',
  stage: 'new', source: 'website_form', isDelete: false, updatedAt: new Date('2026-11-20'),
  marketingConsent: { status: 'granted', at: new Date('2026-11-20'), source: 'demo_form', note: null, askedAt: null, ip: '1.2.3.4' },
  brevo: { syncedAt: null, error: null, pending: true },
  ...over,
});

describe('SalesBrevoService: connect', () => {
  it('verifies the key, creates the fields (already-exists is fine), finds the folder, creates the list, saves the key encrypted and queues consented leads', async () => {
    const t = setup();
    await t.leads.create(lead({ brevo: { syncedAt: null, error: null, pending: false } }));
    await t.leads.create(lead({ email: 'nope@example.com', marketingConsent: { status: 'none' }, brevo: { pending: false } }));
    t.setReply((m, p) => {
      if (p === '/account') return { json: { email: 'owner@solvexo.store', companyName: 'Solvexo' } };
      if (p === '/contacts/attributes/normal/CITY') return { status: 400, json: { code: 'invalid_parameter', message: 'Attribute name must be unique' } };
      if (p === '/contacts/attributes/normal/LEAD_STAGE') return { status: 409, json: { message: 'already exists' } };
      if (p.startsWith('/contacts/attributes')) return { status: 201 };
      if (p.startsWith('/contacts/folders?')) return { json: { folders: [{ id: 3, name: 'Other' }, { id: 7, name: 'Solvexo' }], count: 2 } };
      if (p.startsWith('/contacts/lists?')) return { json: { lists: [{ id: 5, name: 'Newsletter' }], count: 1 } };
      if (m === 'POST' && p === '/contacts/lists') return { status: 201, json: { id: 42 } };
      return { status: 500 };
    });
    const r = await t.brevo.connect(`  ${KEY} `);
    expect(t.calls.every((c) => c.headers['api-key'] === KEY)).toBe(true);
    expect(t.calls.filter((c) => c.url.includes('/contacts/attributes/normal/')).map((c) => c.url.split('/').pop()))
      .toEqual(['COMPANY', 'CITY', 'LEAD_STAGE', 'LEAD_SOURCE', 'LEAD_CAMPAIGN']);
    expect(t.calls.find((c) => c.url.endsWith('/contacts/attributes/normal/COMPANY'))!.body).toEqual({ type: 'text' });
    expect(t.calls.some((c) => c.method === 'POST' && c.url.endsWith('/contacts/folders'))).toBe(false);
    expect(t.calls.find((c) => c.method === 'POST' && c.url.endsWith('/contacts/lists'))!.body).toEqual({ name: 'Solvexo – Sales leads', folderId: 7 });

    const s = t.settings.rows[0];
    expect(s.brevoApiKeyEnc).toBeTruthy();
    expect(s.brevoApiKeyEnc).not.toContain(KEY);
    expect(s).toMatchObject({ brevoListId: 42, brevoFolderId: 7, brevoAccountEmail: 'owner@solvexo.store' });
    expect(s.brevoWebhookSecret).toMatch(/^[a-f0-9]{32}$/);
    expect(r.data).toMatchObject({ connected: true, accountEmail: 'owner@solvexo.store', keyHint: '••••a1b2', listId: 42, listName: 'Solvexo – Sales leads' });
    expect(r.data.webhookUrl).toBe(`https://api.solvexo.store/api/sales/brevo/webhook/${s.brevoWebhookSecret}`);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(t.leads.rows.map((l) => l.brevo.pending)).toEqual([true, false]);
    expect(r.data.counts).toMatchObject({ granted: 1, pending: 1 });
    expect(JSON.stringify(t.activityLog.log.mock.calls)).not.toContain(KEY);
  });

  it('creates the folder when there is none', async () => {
    const t = setup();
    t.setReply((m, p) =>
      p === '/account' ? { json: { email: 'o@x.com' } }
        : p.startsWith('/contacts/folders?') ? { json: { folders: [] } }
          : m === 'POST' && p === '/contacts/folders' ? { status: 201, json: { id: 9 } }
            : p.startsWith('/contacts/lists?') ? { json: { lists: [] } }
              : m === 'POST' && p === '/contacts/lists' ? { status: 201, json: { id: 11 } }
                : { status: 201 });
    await t.brevo.connect(KEY);
    expect(t.calls.find((c) => c.url.endsWith('/contacts/folders'))!.body).toEqual({ name: 'Solvexo' });
    expect(t.settings.rows[0]).toMatchObject({ brevoFolderId: 9, brevoListId: 11 });
  });

  it('says so when Brevo refuses the key, and saves nothing', async () => {
    const t = setup();
    t.setReply(() => ({ status: 401, json: { code: 'unauthorized', message: 'Key not found' } }));
    await expect(t.brevo.connect(KEY)).rejects.toThrow("Brevo didn't accept that API key.");
    expect(t.settings.rows).toHaveLength(0);
  });

  it('disconnect forgets the key and the list but keeps consent', async () => {
    const t = setup();
    await t.connect();
    await t.leads.create(lead());
    const r = await t.brevo.disconnect();
    expect(r.data).toMatchObject({ connected: false, keyHint: null, listId: null, webhookUrl: null });
    expect(t.leads.rows[0].marketingConsent.status).toBe('granted');
  });
});

describe('SalesBrevoService: sync', () => {
  it('sends nothing while Brevo is not connected (leads stay pending)', async () => {
    const t = setup();
    await t.leads.create(lead());
    expect(await t.brevo.syncBatch()).toEqual({ synced: 0, failed: 0 });
    expect(t.calls).toHaveLength(0);
    expect(t.leads.rows[0].brevo.pending).toBe(true);
  });

  it('upserts granted leads into the list and removes withdrawn ones', async () => {
    const t = setup();
    await t.connect();
    await t.leads.create(lead({ utm: { campaign: 'eid' } }));
    await t.leads.create(lead({ email: 'gone@example.com', marketingConsent: { status: 'withdrawn', at: new Date(), source: 'brevo' } }));
    await t.leads.create(lead({ email: 'asked@example.com', marketingConsent: { status: 'asked' } }));
    const r = await t.brevo.syncBatch();
    expect(r).toEqual({ synced: 2, failed: 0 });
    const upsert = t.calls.find((c) => c.url.endsWith('/contacts'))!;
    expect(upsert.body).toEqual({
      email: 'ayesha@example.com', listIds: [42], updateEnabled: true,
      attributes: { FIRSTNAME: 'Ayesha', LASTNAME: 'Khan', COMPANY: 'Khan Fabrics', CITY: 'Lahore', WHATSAPP: '+923001234567', LEAD_STAGE: 'new', LEAD_SOURCE: 'website_form', LEAD_CAMPAIGN: 'eid' },
    });
    const remove = t.calls.find((c) => c.url.endsWith('/contacts/lists/42/contacts/remove'))!;
    expect(remove.body).toEqual({ emails: ['gone@example.com'] });
    expect(t.calls).toHaveLength(2); // nothing sent for the 'asked' lead
    for (const l of t.leads.rows) expect(l.brevo).toMatchObject({ pending: false, error: null });
    expect(t.leads.rows[0].brevo.syncedAt).toBeInstanceOf(Date);
    expect(t.leads.rows[2].brevo.syncedAt).toBeNull();
    expect(t.settings.rows[0].brevoLastSyncAt).toBeInstanceOf(Date);
    // timestamps:false — a sync must not reorder the leads list
    expect(t.leads.updateOne.mock.calls.filter((c: any[]) => c[2]?.timestamps === false).length).toBeGreaterThanOrEqual(3);
  });

  it('a 4xx (not 429) stops retrying that lead; 429 and network errors keep it pending', async () => {
    const t = setup();
    await t.connect();
    await t.leads.create(lead({ email: 'bad@example.com' }));
    await t.leads.create(lead({ email: 'busy@example.com' }));
    await t.leads.create(lead({ email: 'down@example.com' }));
    t.setReply((m, p, body) =>
      body?.email === 'bad@example.com' ? { status: 400, json: { code: 'invalid_parameter', message: `Invalid WHATSAPP number (key ${KEY})` } }
        : body?.email === 'busy@example.com' ? { status: 429, json: { message: 'Too many requests' } }
          : (() => { throw new Error('socket hang up'); })());
    const r = await t.brevo.syncBatch();
    expect(r).toEqual({ synced: 0, failed: 3 });
    const [bad, busy, down] = t.leads.rows;
    expect(bad.brevo.pending).toBe(false);
    expect(bad.brevo.error).toContain('Brevo 400: Invalid WHATSAPP number');
    expect(bad.brevo.error).not.toContain(KEY);
    expect(busy.brevo).toMatchObject({ pending: true, error: 'Brevo 429: Too many requests' });
    expect(down.brevo).toMatchObject({ pending: true, error: 'socket hang up' });
    expect(t.settings.rows[0].brevoLastError).toBeTruthy();
  });

  it('a rejected key keeps every lead pending and shows the error in the settings', async () => {
    const t = setup();
    await t.connect();
    await t.leads.create(lead());
    t.setReply(() => ({ status: 401, json: { message: 'Key not found' } }));
    await t.brevo.syncBatch();
    expect(t.leads.rows[0].brevo).toMatchObject({ pending: true, error: null });
    expect(t.settings.rows[0].brevoLastError).toContain('connect Brevo again');
  });

  it('Sync now queues granted and withdrawn leads with an email and runs a batch', async () => {
    const t = setup();
    await t.connect();
    await t.leads.create(lead({ brevo: { pending: false } }));
    await t.leads.create(lead({ email: 'w@example.com', marketingConsent: { status: 'withdrawn' }, brevo: { pending: false } }));
    await t.leads.create(lead({ email: null, brevo: { pending: false } }));
    await t.leads.create(lead({ email: 'n@example.com', marketingConsent: { status: 'none' }, brevo: { pending: false } }));
    const r = await t.brevo.syncNow();
    expect(r.data).toEqual({ queued: 2, synced: 2, failed: 0 });
  });
});

describe('consent rules', () => {
  it('a hand-set grant needs a note saying where and when', async () => {
    const t = setup();
    await expect(t.sales.create(SUPER, { name: 'Ali', email: 'ali@example.com', marketingConsent: true })).rejects.toThrow(BadRequestException);
    await expect(t.sales.create(SUPER, { name: 'Ali', email: 'ali@example.com', marketingConsent: true, marketingConsentNote: ' ok ' })).rejects.toThrow("Say where and when the lead agreed, e.g. 'Asked on call 24 Nov'");
    expect(t.leads.rows).toHaveLength(0);
    const r: any = await t.sales.create(SUPER, { name: 'Ali', email: 'ali@example.com', marketingConsent: true, marketingConsentNote: 'Asked on call 24 Nov' });
    expect(r.data.lead.marketingConsent).toMatchObject({ status: 'granted', source: 'manual', note: 'Asked on call 24 Nov' });
    expect(r.data.lead.marketingConsent).not.toHaveProperty('ip');
    expect(r.data.lead.brevo).toEqual({ syncedAt: null, error: null, pending: true });
    expect(t.activities.rows.some((a) => a.body.includes('agreed to marketing emails'))).toBe(true);
  });

  it('update: grant needs a note; false on a granted lead withdraws it and queues the removal', async () => {
    const t = setup();
    const r: any = await t.sales.create(SUPER, { name: 'Ali', email: 'ali@example.com' });
    const id = r.data.lead._id;
    expect(r.data.lead.marketingConsent.status).toBe('none');
    await expect(t.sales.update(SUPER, id, { marketingConsent: true })).rejects.toThrow(BadRequestException);
    await t.sales.update(SUPER, id, { marketingConsent: true, marketingConsentNote: 'WhatsApp chat 20 Nov' });
    expect(t.leads.rows[0].marketingConsent).toMatchObject({ status: 'granted', source: 'manual' });
    t.leads.rows[0].brevo = { syncedAt: new Date(), error: null, pending: false };
    // A field we send to Brevo changed → queued again
    await t.sales.update(SUPER, id, { city: 'Karachi' });
    expect(t.leads.rows[0].brevo.pending).toBe(true);
    t.leads.rows[0].brevo.pending = false;
    // A field we don't send → not queued
    await t.sales.update(SUPER, id, { dealValuePKR: 5000 });
    expect(t.leads.rows[0].brevo.pending).toBe(false);
    // Stage change → queued
    await t.sales.changeStage(SUPER, id, 'contacted');
    expect(t.leads.rows[0].brevo.pending).toBe(true);
    t.leads.rows[0].brevo.pending = false;
    const w: any = await t.sales.update(SUPER, id, { marketingConsent: false });
    expect(w.data.lead.marketingConsent).toMatchObject({ status: 'withdrawn', source: 'manual' });
    expect(t.leads.rows[0].brevo.pending).toBe(true);
    expect(t.activities.rows.some((a) => a.body.startsWith('Marked as no longer wanting marketing emails'))).toBe(true);
  });

  it('the list filters by consent (old leads without a status count as none)', async () => {
    const t = setup();
    await t.leads.create(lead());
    await t.leads.create({ ...lead({ email: 'old@example.com' }), marketingConsent: undefined });
    const g: any = await t.sales.list(SUPER, { consent: 'granted' });
    const n: any = await t.sales.list(SUPER, { consent: 'none' });
    expect(g.data.items.map((l: any) => l.email)).toEqual(['ayesha@example.com']);
    expect(n.data.items.map((l: any) => l.email)).toEqual(['old@example.com']);
    expect(n.data.items[0].marketingConsent.status).toBe('none');
  });

  it('the demo form grants consent when ticked (with the IP) and an unticked form never takes it away', async () => {
    const t = setup();
    await t.capture.demoRequest({ name: 'Sara Ali', phone: '03001112223', email: 'Sara@Example.com', marketingOptIn: true }, '9.9.9.9');
    await flush();
    const l = t.leads.rows[0];
    expect(l.marketingConsent).toMatchObject({ status: 'granted', source: 'demo_form', ip: '9.9.9.9' });
    expect(l.brevo.pending).toBe(true);
    expect(t.activities.rows.some((a) => a.body === 'Agreed to marketing emails (Book a demo form)')).toBe(true);
    await t.capture.demoRequest({ name: 'Sara Ali', phone: '03001112223', email: 'sara@example.com', marketingOptIn: false }, null);
    await flush();
    expect(t.leads.rows).toHaveLength(1);
    expect(t.leads.rows[0].marketingConsent.status).toBe('granted');
  });

  it('a ticked form without an email records nothing; the Contact Us form grants with its own source', async () => {
    const t = setup();
    await t.capture.demoRequest({ name: 'No Mail', phone: '03004445556', marketingOptIn: true });
    await flush();
    expect(t.leads.rows[0].marketingConsent?.status ?? 'none').toBe('none');
    await t.capture.fromContactMessage({ name: 'Zara', email: 'zara@example.com', topic: 'Selling on Solvexo', message: 'Hi' }, { marketingOptIn: true, ip: '8.8.8.8' });
    await flush();
    expect(t.leads.rows[1].marketingConsent).toMatchObject({ status: 'granted', source: 'contact_form', ip: '8.8.8.8' });
    expect(t.activities.rows.some((a) => a.body === 'Agreed to marketing emails (Contact Us form)')).toBe(true);
  });
});

describe('permission emails, confirmation link, webhook, export', () => {
  it('asks each never-asked lead once, and the link grants consent', async () => {
    const t = setup();
    await t.leads.create(lead({ name: 'Ali <b>Raza</b>', businessName: 'A&B', marketingConsent: { status: 'none' }, brevo: { pending: false } }));
    await t.leads.create(lead({ email: 'asked@example.com', marketingConsent: { status: 'asked' }, brevo: { pending: false } }));
    await t.leads.create({ ...lead({ email: 'legacy@example.com', brevo: { pending: false } }), marketingConsent: undefined });
    await t.leads.create(lead({ email: null, marketingConsent: { status: 'none' } }));
    const r = await t.brevo.requestConsent(SUPER, {});
    expect(r.data).toEqual({ sent: 2, skipped: 0, more: 0 });
    // Marked asked before any email goes out, so a retry while sending can't email them twice
    expect(t.leads.rows[0].marketingConsent).toMatchObject({ status: 'asked' });
    await t.brevo.consentRun;
    const [to, subject, html] = t.email.sendMail.mock.calls[0] as any[];
    expect(to).toBe('ayesha@example.com');
    expect(subject).toBe('Can we keep you posted?');
    expect(html).toContain('Hi Ali, you were in touch with Solvexo about A&amp;B.');
    expect(html).not.toContain('<b>Raza');
    expect(html).toContain('Yes, keep me posted');
    expect(html).toMatch(/If you don(&#39;|&#x27;|')t click, we won(&#39;|&#x27;|')t add you to our mailing list\./);
    expect(t.leads.rows[0].marketingConsent).toMatchObject({ status: 'asked' });
    expect(t.leads.rows[0].marketingConsent.askedAt).toBeInstanceOf(Date);
    // Asking again: nobody left to ask
    const again = await t.brevo.requestConsent(SUPER, { leadIds: [String(t.leads.rows[0]._id), String(t.leads.rows[1]._id), 'not-an-id'] });
    expect(again.data).toEqual({ sent: 0, skipped: 3, more: 0 });
    await t.brevo.consentRun;
    expect(t.email.sendMail).toHaveBeenCalledTimes(2);

    const link = /href="([^"]+\/api\/sales\/consent\/[^"]+)"/.exec(html)![1];
    const token = link.split('/').pop()!;
    expect(await t.brevo.confirmConsent(token, '5.5.5.5')).toBe('https://solvexo.store/email-preferences/confirmed?status=ok');
    expect(t.leads.rows[0].marketingConsent).toMatchObject({ status: 'granted', source: 'email_confirm', ip: '5.5.5.5' });
    expect(t.leads.rows[0].brevo.pending).toBe(true);
    expect(await t.brevo.confirmConsent(token, null)).toContain('status=ok'); // idempotent
    expect(t.activities.rows.filter((a) => a.body.startsWith('Agreed to marketing emails (clicked')).length).toBe(1);
    expect(await t.brevo.confirmConsent(`${token}x`, null)).toBe('https://solvexo.store/email-preferences/confirmed?status=invalid');
  });

  it('without ticked leads it asks every lead the filters match, not just the loaded page', async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) await t.leads.create(lead({ email: `w${i}@example.com`, stage: 'won', marketingConsent: { status: 'none' } }));
    await t.leads.create(lead({ email: 'new@example.com', stage: 'new', marketingConsent: { status: 'none' } }));
    await t.leads.create(lead({ email: 'g@example.com', stage: 'won', marketingConsent: { status: 'granted' } }));
    // A consent filter other than "not asked" can't widen it to people already asked or agreed
    const r = await t.brevo.requestConsent(SUPER, { filters: { stage: 'won', consent: 'granted' } as any });
    expect(r.data).toEqual({ sent: 0, skipped: 0, more: 0 });
    const r2 = await t.brevo.requestConsent(SUPER, { filters: { stage: 'won' } as any });
    expect(r2.data).toEqual({ sent: 3, skipped: 0, more: 0 });
    await t.brevo.consentRun;
    expect(t.email.sendMail.mock.calls.map((c: any[]) => c[0]).sort()).toEqual(['w0@example.com', 'w1@example.com', 'w2@example.com']);
    expect(t.leads.rows.find((l: any) => l.email === 'new@example.com').marketingConsent.status).toBe('none');
  });

  it('a failed send puts the lead back so it can be asked again', async () => {
    const t = setup();
    await t.leads.create(lead({ marketingConsent: { status: 'none' } }));
    t.email.sendMail.mockResolvedValueOnce(false);
    const r = await t.brevo.requestConsent(SUPER, {});
    expect(r.data.sent).toBe(1);
    await t.brevo.consentRun;
    expect(t.leads.rows[0].marketingConsent).toMatchObject({ status: 'none', askedAt: null });
    expect(t.activities.rows.some((a: any) => String(a.body).startsWith('Asked by email'))).toBe(false);
  });

  it('an old link does not undo a later unsubscribe', async () => {
    const t = setup();
    const l = await t.leads.create(lead({ marketingConsent: { status: 'withdrawn', at: new Date(Date.now() + 1000), source: 'brevo' } }));
    expect(await t.brevo.confirmConsent(signConsentToken(String(l._id)), null)).toContain('status=invalid');
    expect(t.leads.rows[0].marketingConsent.status).toBe('withdrawn');
  });

  it('the webhook needs the secret, and an unsubscribe withdraws consent for good', async () => {
    const t = setup();
    await expect(t.brevo.webhook('x'.repeat(32), { event: 'unsubscribed', email: 'a@b.co' })).rejects.toThrow(NotFoundException);
    await t.connect();
    const secret = t.settings.rows[0].brevoWebhookSecret;
    await t.leads.create(lead({ brevo: { pending: false } }));
    await expect(t.brevo.webhook('0'.repeat(32), {})).rejects.toThrow(NotFoundException);
    expect(await t.brevo.webhook(secret, [{ event: 'opened', email: 'ayesha@example.com' }, { event: 'unsubscribed', email: 'AYESHA@example.com' }])).toEqual({ ok: true });
    expect(t.leads.rows[0].marketingConsent).toMatchObject({ status: 'withdrawn', source: 'brevo' });
    expect(t.activities.rows.some((a) => a.body === 'Unsubscribed in Brevo')).toBe(true);
    await t.brevo.webhook(secret, { event: 'unsubscribed', email: 'ayesha@example.com' });
    expect(t.activities.rows.filter((a) => a.body === 'Unsubscribed in Brevo')).toHaveLength(1);
    // The sync takes them off the list and never adds them back
    await t.brevo.syncBatch();
    expect(t.calls.map((c) => c.url)).toEqual(['https://api.brevo.com/v3/contacts/lists/42/contacts/remove']);
  });

  it('exports only consented leads with an email, as CSV', async () => {
    const t = setup();
    await t.leads.create(lead({ businessName: '@risky' }));
    await t.leads.create(lead({ email: 'no@example.com', marketingConsent: { status: 'none' } }));
    await t.leads.create(lead({ email: null }));
    const r = await t.brevo.exportCsv(SUPER, {}, { adminId: SUPER.adminId });
    expect(r.count).toBe(1);
    expect(r.filename).toMatch(/^solvexo-leads-brevo-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(r.csv.split('\r\n')[1]).toContain("ayesha@example.com,Ayesha,Khan,'@risky,Lahore,+923001234567");
    expect(t.activityLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'sales.leads.export_brevo', metadata: { count: 1 } }));
    expect((await t.brevo.exportCsv(SUPER, { consent: 'none' })).count).toBe(0);
  });
});
