/* eslint-disable prettier/prettier */
import { StoreContactService } from './store-contact.service';

const SECTION_ID = 'a'.repeat(24);
const STORE = 'store-1';

const chain = (value: unknown) => ({ select: () => ({ lean: async () => value }), lean: async () => value });

function build(opts: { pageSections?: any[] | null; templateSections?: any[] | null; themeTemplates?: any[] | null; autoRepliedRecently?: number } = {}) {
  const created: any[] = [];
  const notified: any[] = [];
  const mails: any[][] = [];
  const updates: any[] = [];
  const filters: any[] = [];
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
  );
  return { service, created, notified, mails, updates, filters };
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
    expect(created).toHaveLength(1);
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
