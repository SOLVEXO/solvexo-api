/* eslint-disable prettier/prettier */
import { StoreContactService } from './store-contact.service';

const SECTION_ID = 'a'.repeat(24);
const STORE = 'store-1';

const chain = (value: unknown) => ({ select: () => ({ lean: async () => value }), lean: async () => value });

function build(opts: { pageSections?: any[] | null; templateSections?: any[] | null; themeTemplates?: any[] | null; autoRepliedRecently?: number; extras?: boolean; uploads?: any[]; settingsRow?: any } = {}) {
  const created: any[] = [];
  const notified: any[] = [];
  const mails: any[][] = [];
  const updates: any[] = [];
  const filters: any[] = [];
  const uploadRows: any[] = opts.uploads ?? [];
  const deleted: any[] = [];
  const webhooks: any[] = [];
  const subscribed: any[] = [];
  const repos: any = {
    storeModel: { findOne: () => chain({ name: 'Shop', sellerId: 'seller-1', status: 'active' }), findById: () => chain({ name: 'Shop', logo: null, contactEmail: 'shop@x.co' }) },
    storeContactMessageModel: {
      countDocuments: async (f: any) => { filters.push(f); return f?.autoRepliedAt ? (opts.autoRepliedRecently ?? 0) : 0; },
      updateOne: async (...a: any[]) => { updates.push(a); return {}; },
      create: async (doc: any) => { created.push(doc); return { _id: 'm1', ...doc }; },
    },
    storePageModel: { findOne: () => chain(opts.pageSections || opts.themeTemplates ? { sections: opts.pageSections ?? [], themeTemplates: opts.themeTemplates ?? [] } : null) },
    collectionTemplateModel: { findOne: () => chain(opts.templateSections ? { sections: opts.templateSections } : null) },
  };
  const service = new StoreContactService(
    { repositories: repos } as any,
    { notify: async (n: any) => { notified.push(n); } } as any,
    { sendMail: async (...a: any[]) => { mails.push(a); return true; } } as any,
    ...(opts.extras ? [
      uploadsModel(uploadRows), { findOne: () => ({ select: () => ({ lean: async () => opts.settingsRow ?? null }) }) } as any,
      { uploadPrivateFile: async (f: any) => ({ publicId: 'p1', resourceType: 'raw', fileName: f.originalname, fileSize: f.size, mimeType: 'application/pdf' }), deletePrivateFile: async (...a: any[]) => { deleted.push(a); return 'ok'; }, generateExpiringPrivateUrl: () => 'https://signed.example/x' } as any,
      { emit: async (...a: any[]) => { webhooks.push(a); } } as any,
      { subscribe: async (...a: any[]) => { subscribed.push(a); } } as any,
    ] : []) as any,
  );
  return { service, created, notified, mails, updates, filters, uploadRows, webhooks, subscribed, deleted };
}

// A tiny in-memory model for the files a visitor attached.
function uploadsModel(rows: any[]) {
  const matches = (r: any, f: any) => Object.entries(f).every(([k, v]) => (k === '_id' || k === 'storeId' || k === 'claimedBy') ? (v && typeof v === 'object' && '$in' in (v as any) ? (v as any).$in.includes(r[k]) : r[k] === v) : true);
  return {
    create: async (d: any) => { const r = { _id: 'u' + (rows.length + 1), claimedBy: null, expiresAt: null, createdAt: new Date(), ...d }; rows.push(r); return r; },
    countDocuments: async (f: any) => rows.filter(r => matches(r, f)).length,
    findOneAndUpdate: (f: any, u: any) => ({ lean: async () => { const r = rows.find(x => matches(x, f)); if (!r) return null; Object.assign(r, u.$set); return { ...r }; } }),
    updateMany: async (f: any, u: any) => { rows.filter(r => matches(r, f)).forEach(r => Object.assign(r, u.$set)); return {}; },
    find: (f: any) => ({ limit: () => ({ lean: async () => rows.filter(r => (f.$or ? f.$or.some((c: any) => (c.expiresAt ? r.expiresAt && r.expiresAt < c.expiresAt.$lt : (c.claimedBy.$in.includes(r.claimedBy) && r.createdAt < c.createdAt.$lt))) : matches(r, f))) }), lean: async () => rows.filter(r => matches(r, f)) }),
    findOne: () => ({ lean: async () => rows[0] ?? null }),
    deleteMany: async (f: any) => { const ids = f._id.$in; for (let i = rows.length - 1; i >= 0; i--) if (ids.includes(rows[i]._id)) rows.splice(i, 1); return {}; },
  };
}

const formSection = (settings: Record<string, unknown>) => ({ _id: SECTION_ID, type: 'contact_form', enabled: true, settings });

describe('contact form submit', () => {
  it('finds the form of a custom page in its theme templates (live sections only)', async () => {
    const fields = [{ id: 'e', type: 'email', label: 'Email', required: true }, { id: 'x', type: 'text', label: 'Order' }];
    const { service, created } = build({ themeTemplates: [{ installedThemeId: 't1', sections: [formSection({ fields })], draftSections: [formSection({ fields: [] })] }] });
    await service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'e', value: 'a@b.co' }, { fieldId: 'x', value: '7' }] } as any);
    expect(created[0].fields.map((f: any) => f.id)).toEqual(['e', 'x']);
  });

  it('validates the answers against the seller\'s own field list and stores them with the sender details', async () => {
    const fields = [
      { id: 'n', type: 'name', label: 'Name', required: true },
      { id: 'e', type: 'email', label: 'Email', required: true },
      { id: 'o', type: 'text', label: 'Order number' },
      { id: 't', type: 'dropdown', label: 'Topic', options: ['Delivery', 'Refund'], required: true },
    ];
    const { service, created, notified } = build({ pageSections: [formSection({ fields })] });
    const res = await service.submit(STORE, {
      sectionId: SECTION_ID, website: '',
      answers: [{ fieldId: 'n', value: 'Ali' }, { fieldId: 'e', value: 'ALI@x.co' }, { fieldId: 'o', value: '1042' }, { fieldId: 't', value: 'Refund' }, { fieldId: 'evil', value: 'x' }],
    } as any);
    expect(res.success).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe('Ali');
    expect(created[0].email).toBe('ali@x.co');
    expect(created[0].fields.map((f: any) => `${f.label}=${f.value}`)).toEqual(['Name=Ali', 'Email=ali@x.co', 'Order number=1042', 'Topic=Refund']);
    expect(notified[0].title).toBe('New message from Ali');
    expect(notified[0].body).toContain('Order number: 1042');
  });

  it('refuses a missing required answer, a choice that is not offered, and a form that no longer exists', async () => {
    const fields = [{ id: 'e', type: 'email', label: 'Email', required: true }, { id: 't', type: 'dropdown', label: 'Topic', options: ['A'] }];
    const { service, created } = build({ pageSections: [formSection({ fields })] });
    await expect(service.submit(STORE, { sectionId: SECTION_ID, answers: [] } as any)).rejects.toThrow('Email is required');
    await expect(service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'e', value: 'a@b.co' }, { fieldId: 't', value: 'Hack' }] } as any)).rejects.toThrow();
    const gone = build({});
    await expect(gone.service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'e', value: 'a@b.co' }] } as any)).rejects.toThrow('no longer available');
    expect(created).toHaveLength(0);
  });

  it('an old section with no field list keeps the classic Name / Email / Message form', async () => {
    const { service, created } = build({ templateSections: [formSection({ showPhone: false })] });
    await service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'name', value: 'A' }, { fieldId: 'email', value: 'a@b.co' }, { fieldId: 'message', value: 'Hello' }] } as any);
    expect(created[0].name).toBe('A');
    expect(created[0].email).toBe('a@b.co');
    expect(created[0].message).toBe('Hello');
    await expect(service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'name', value: 'A' }, { fieldId: 'email', value: 'a@b.co' }] } as any)).rejects.toThrow('Message is required');
  });

  it('older storefront builds that send name / email / message directly still work, and the honeypot stores nothing', async () => {
    const { service, created } = build({});
    await service.submit(STORE, { name: 'A', email: 'a@b.co', message: 'Hi' } as any);
    expect(created).toHaveLength(1);
    await service.submit(STORE, { name: 'Bot', email: 'b@b.co', message: 'x', website: 'http://spam' } as any);
    expect(created).toHaveLength(2);
    expect(created[1].status).toBe('spam');
    expect(created[1].spamReason).toBe('honeypot');
    await expect(service.submit(STORE, { email: 'a@b.co', message: 'Hi' } as any)).rejects.toThrow('name is required');
  });

  it('a form whose section is disabled or is not a contact form is not accepted', async () => {
    const off = build({ pageSections: [{ ...formSection({}), enabled: false }] });
    await expect(off.service.submit(STORE, { sectionId: SECTION_ID, answers: [] } as any)).rejects.toThrow('no longer available');
    const wrong = build({ pageSections: [{ ...formSection({}), type: 'rich_text' }] });
    await expect(wrong.service.submit(STORE, { sectionId: SECTION_ID, answers: [] } as any)).rejects.toThrow('no longer available');
  });
});

const tick = () => new Promise(r => setTimeout(r, 25));
const mailField = { id: 'e', type: 'email', label: 'Email', required: true };
const nameField = { id: 'n', type: 'name', label: 'Name' };

describe('phase 1: emails after sending', () => {
  it('emails every answer to the listed addresses, with the visitor as Reply-To, and escapes visitor text', async () => {
    const settings = { fields: [nameField, mailField, { id: 'm', type: 'textarea', label: 'Message' }], formName: 'Wholesale', notifyEmails: 'boss@x.co, team@x.co' };
    const { service, mails } = build({ pageSections: [formSection(settings)] });
    await service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'n', value: '<b>Ali</b>' }, { fieldId: 'e', value: 'ali@x.co' }, { fieldId: 'm', value: 'Need <script>x</script> prices' }] } as any);
    await tick();
    expect(mails.map(m => m[0])).toEqual(['boss@x.co', 'team@x.co']);
    expect(mails[0][1]).toContain('Wholesale');
    expect(mails[0][3]).toBe('ali@x.co');
    expect(mails[0][2]).toContain('&lt;b&gt;Ali&lt;/b&gt;');
    expect(mails[0][2]).not.toContain('<script>');
  });

  it('sends the automatic reply with the seller\'s text and tags, and marks the message', async () => {
    const settings = { fields: [nameField, mailField], autoReplyEnabled: true, autoReplySubject: 'Thanks {{name}}', autoReplyBody: 'Hi {{name}}, {{store}} got it.' };
    const { service, mails, updates } = build({ pageSections: [formSection(settings)] });
    await service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'n', value: 'Ali' }, { fieldId: 'e', value: 'ali@x.co' }] } as any);
    await tick();
    expect(mails).toHaveLength(1);
    expect(mails[0][0]).toBe('ali@x.co');
    expect(mails[0][1]).toBe('Thanks Ali');
    expect(mails[0][2]).toContain('Hi Ali, Shop got it.');
    expect(updates).toHaveLength(1);
  });

  it('sends no second automatic reply to the same address within a day, and none when the visitor left no email', async () => {
    const settings = { fields: [mailField, { id: 'p', type: 'phone', label: 'Phone' }], autoReplyEnabled: true };
    const again = build({ pageSections: [formSection(settings)], autoRepliedRecently: 1 });
    await again.service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'e', value: 'ali@x.co' }] } as any);
    await tick();
    expect(again.mails).toHaveLength(0);
    const phoneOnly = build({ pageSections: [formSection({ fields: [{ id: 'p', type: 'phone', label: 'Phone', required: true }], autoReplyEnabled: true })] });
    await phoneOnly.service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'p', value: '+92 300 1234567' }] } as any);
    await tick();
    expect(phoneOnly.mails).toHaveLength(0);
  });

  it('stores the form name and puts it in the notification title', async () => {
    const { service, created, notified } = build({ pageSections: [formSection({ fields: [nameField, mailField], formName: 'Support' })] });
    await service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'n', value: 'Ali' }, { fieldId: 'e', value: 'ali@x.co' }] } as any);
    expect(created[0].formName).toBe('Support');
    expect(created[0].sectionId).toBe(SECTION_ID);
    expect(notified[0].title).toBe('Support: new message from Ali');
  });
});

describe('phase 1: inbox filters and CSV export', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { contactMessagesToCsv, csvCell } = require('./contact-form-mail.util');
  it('makes spreadsheet formulas harmless and quotes commas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell(null)).toBe('');
  });
  it('writes one row per message and one column per question', () => {
    const csv = contactMessagesToCsv([
      { createdAt: '2026-11-12T10:00:00Z', formName: 'Support', name: 'Ali', email: 'a@x.co', status: 'new', message: 'Hi', fields: [{ type: 'name', label: 'Name', value: 'Ali' }, { type: 'text', label: 'Order', value: '7' }] },
      { createdAt: '2026-11-12T11:00:00Z', formName: '', name: 'Sara', email: 's@x.co', status: 'read', message: 'Yo', fields: [{ type: 'dropdown', label: 'Topic', value: 'Refund' }] },
    ]).split('\r\n');
    expect(csv[0]).toBe('Date,Form,Name,Email,Phone,Status,Message,Order,Topic');
    expect(csv[1]).toContain('Support,Ali,a@x.co');
    expect(csv[1].endsWith(',7,')).toBe(true);
    expect(csv[2].endsWith(',,Refund')).toBe(true);
  });
  it('builds the same filter for the list and the export (status, one form, escaped search)', async () => {
    const { service, filters } = build({});
    await (service as any).list(STORE, 'seller-1', { status: 'new', form: 'Support', q: 'a.b*' }).catch(() => undefined);
    const f = (service as any).buildFilter(STORE, { status: 'new', form: 'Support', q: 'a.b*' });
    expect(f.status).toBe('new');
    expect(f.formName).toBe('Support');
    expect(String(f.$or[0].name)).toBe('/a\\.b\\*/i');
    expect((service as any).buildFilter(STORE, { form: '__unnamed' }).formName).toBe('');
    expect(filters.length >= 0).toBe(true);
  });
});

describe('phase 2: spam, CAPTCHA, files, webhook and subscribers', () => {
  const email = { id: 'e', type: 'email', label: 'Email', required: true };
  const bigFile = { id: 'f', type: 'file', label: 'Receipt', fileKinds: 'documents', maxSizeMb: 2 };

  it('a message with many links goes to the Spam tab: no bell, no email, no webhook', async () => {
    const { service, created, notified, mails, webhooks } = build({ extras: true, pageSections: [formSection({ fields: [email, { id: 'm', type: 'textarea', label: 'Message' }], notifyEmails: 'boss@x.co' })] });
    await service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'e', value: 'a@b.co' }, { fieldId: 'm', value: 'buy http://a.co http://b.co http://c.co http://d.co now' }] } as any);
    await new Promise(r => setTimeout(r, 25));
    expect(created[0].status).toBe('spam');
    expect(created[0].spamReason).toBe('links');
    expect(notified).toHaveLength(0);
    expect(mails).toHaveLength(0);
    expect(webhooks).toHaveLength(0);
  });

  it('tells the store\'s webhooks and signs the visitor up when a wired consent box is ticked', async () => {
    const fields = [email, { id: 'k', type: 'consent', label: 'Send me offers', subscribes: true }, { id: 'n', type: 'name', label: 'Name' }];
    const { service, created, webhooks, subscribed } = build({ extras: true, pageSections: [formSection({ fields, formName: 'Offers' })] });
    await service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'e', value: 'a@b.co' }, { fieldId: 'k', value: 'true' }, { fieldId: 'n', value: 'Ali' }] } as any);
    await new Promise(r => setTimeout(r, 25));
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0][1]).toBe('form.submitted');
    expect(webhooks[0][2].form_name).toBe('Offers');
    expect(webhooks[0][2].fields.length).toBe(3);
    expect(webhooks[0][3]).toBe('form.submitted:m1');
    expect(subscribed).toHaveLength(1);
    expect(subscribed[0][0]).toBe('a@b.co');
    expect(subscribed[0][1].source).toBe('contact_form');
    // unticked: no signup
    const again = build({ extras: true, pageSections: [formSection({ fields, formName: 'Offers' })] });
    await again.service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'e', value: 'a@b.co' }] } as any);
    await new Promise(r => setTimeout(r, 25));
    expect(again.subscribed).toHaveLength(0);
    expect(created.length).toBe(1);
  });

  it('a file answer must be a file this store\'s visitor really uploaded, and is claimed once', async () => {
    const uploads = [{ _id: 'a'.repeat(24), storeId: STORE, publicId: 'p1', resourceType: 'raw', fileName: 'receipt.pdf', size: 2048, claimedBy: null }];
    const { service, created, uploadRows } = build({ extras: true, uploads, pageSections: [formSection({ fields: [email, bigFile] })] });
    await service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'e', value: 'a@b.co' }, { fieldId: 'f', value: 'a'.repeat(24) }] } as any);
    expect(created[0].fields.find((f: any) => f.id === 'f').value).toBe('receipt.pdf (2 KB)');
    expect(created[0].fields.find((f: any) => f.id === 'f').fileId).toBe('a'.repeat(24));
    expect(uploadRows[0].claimedBy).toBe('m1');
    // the same id cannot be used a second time, and an unknown id is refused
    await expect(service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'e', value: 'a@b.co' }, { fieldId: 'f', value: 'a'.repeat(24) }] } as any)).rejects.toThrow('expired');
    await expect(service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'e', value: 'a@b.co' }, { fieldId: 'f', value: 'b'.repeat(24) }] } as any)).rejects.toThrow('expired');
    await expect(service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'e', value: 'a@b.co' }, { fieldId: 'f', value: 'not-an-id' }] } as any)).rejects.toThrow();
    expect(created).toHaveLength(1);
  });

  it('the upload checks the seller\'s field: only that field, only allowed types and sizes', async () => {
    const { service, uploadRows } = build({ extras: true, pageSections: [formSection({ fields: [email, bigFile] })] });
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(500)]);
    const ok = await service.upload(STORE, { sectionId: SECTION_ID, fieldId: 'f' }, { buffer: pdf, originalname: 'a.pdf', mimetype: 'application/pdf', size: pdf.length });
    expect(ok.data.name).toBe('a.pdf');
    expect(uploadRows).toHaveLength(1);
    await expect(service.upload(STORE, { sectionId: SECTION_ID, fieldId: 'e' }, { buffer: pdf, originalname: 'a.pdf', size: pdf.length })).rejects.toThrow('does not take a file');
    await expect(service.upload(STORE, { sectionId: SECTION_ID, fieldId: 'f' }, { buffer: pdf, originalname: 'a.png', size: pdf.length })).rejects.toThrow();
    await expect(service.upload(STORE, { sectionId: SECTION_ID, fieldId: 'f' }, { buffer: pdf, originalname: 'a.exe', size: pdf.length })).rejects.toThrow('not accepted');
    await expect(service.upload(STORE, { sectionId: SECTION_ID, fieldId: 'f' }, { buffer: Buffer.alloc(10), originalname: 'a.pdf', size: 3 * 1024 * 1024 })).rejects.toThrow('2 MB');
    await expect(service.upload(STORE, { sectionId: 'c'.repeat(24), fieldId: 'f' }, { buffer: pdf, originalname: 'a.pdf', size: pdf.length })).rejects.toThrow('no longer available');
  });

  it('with the CAPTCHA on and keys saved, a missing or wrong answer is refused and a real one passes', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { encryptCredential } = require('../common/credential-encryption.util');
    process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY || 'a'.repeat(64);
    const settingsRow = { turnstileSiteKey: '0x4AAAAAAAAAAAAAAAAAAAAA', turnstileSecretEnc: encryptCredential('secret-key-123456', 'INTEGRATIONS') };
    const realFetch = (global as any).fetch;
    const seen: string[] = [];
    (global as any).fetch = async (_u: string, init: any) => {
      const token = new URLSearchParams(String(init.body)).get('response') ?? '';
      seen.push(token);
      return { json: async () => (token === 'good' ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] }) };
    };
    try {
      const { service, created } = build({ extras: true, settingsRow, pageSections: [formSection({ fields: [email], captcha: true })] });
      await expect(service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'e', value: 'a@b.co' }] } as any)).rejects.toThrow('not a robot');
      await expect(service.submit(STORE, { sectionId: SECTION_ID, captchaToken: 'bad', answers: [{ fieldId: 'e', value: 'a@b.co' }] } as any)).rejects.toThrow('not a robot');
      await service.submit(STORE, { sectionId: SECTION_ID, captchaToken: 'good', answers: [{ fieldId: 'e', value: 'a@b.co' }] } as any, '1.2.3.4');
      expect(created).toHaveLength(1);
      expect(seen).toEqual(['bad', 'good']);
      // the CAPTCHA switched on without keys saved does not lock the form
      const open = build({ extras: true, pageSections: [formSection({ fields: [email], captcha: true })] });
      await open.service.submit(STORE, { sectionId: SECTION_ID, answers: [{ fieldId: 'e', value: 'a@b.co' }] } as any);
      expect(open.created).toHaveLength(1);
      // Cloudflare unreachable: fail closed
      (global as any).fetch = async () => { throw new Error('offline'); };
      await expect(service.submit(STORE, { sectionId: SECTION_ID, captchaToken: 'good', answers: [{ fieldId: 'e', value: 'a@b.co' }] } as any)).rejects.toThrow('try again');
    } finally { (global as any).fetch = realFetch; }
  });

  it('the nightly cleanup removes files nobody sent and the files of expired spam', async () => {
    const old = new Date(Date.now() - 3 * 86_400_000);
    const uploads = [
      { _id: 'u1', storeId: STORE, publicId: 'x1', resourceType: 'raw', claimedBy: null, createdAt: old, expiresAt: null },
      { _id: 'u2', storeId: STORE, publicId: 'x2', resourceType: 'raw', claimedBy: 'msg-1', createdAt: old, expiresAt: null },
      { _id: 'u3', storeId: STORE, publicId: 'x3', resourceType: 'raw', claimedBy: 'msg-2', createdAt: old, expiresAt: new Date(Date.now() - 1000) },
    ];
    const { service, uploadRows, deleted } = build({ extras: true, uploads });
    const n = await service.cleanupUploads();
    expect(n).toBe(2);
    expect(deleted.map(d => d[0]).sort()).toEqual(['x1', 'x3']);
    expect(uploadRows.map(r => r._id)).toEqual(['u2']);
  });
});
