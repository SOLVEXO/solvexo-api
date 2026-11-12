/* eslint-disable prettier/prettier */
import { StoreContactService } from './store-contact.service';

const SECTION_ID = 'a'.repeat(24);
const STORE = 'store-1';

const chain = (value: unknown) => ({ select: () => ({ lean: async () => value }), lean: async () => value });

function build(opts: { pageSections?: any[] | null; templateSections?: any[] | null; themeTemplates?: any[] | null } = {}) {
  const created: any[] = [];
  const notified: any[] = [];
  const repos: any = {
    storeModel: { findOne: () => chain({ name: 'Shop', sellerId: 'seller-1', status: 'active' }) },
    storeContactMessageModel: {
      countDocuments: async () => 0,
      create: async (doc: any) => { created.push(doc); return { _id: 'm1', ...doc }; },
    },
    storePageModel: { findOne: () => chain(opts.pageSections || opts.themeTemplates ? { sections: opts.pageSections ?? [], themeTemplates: opts.themeTemplates ?? [] } : null) },
    collectionTemplateModel: { findOne: () => chain(opts.templateSections ? { sections: opts.templateSections } : null) },
  };
  const service = new StoreContactService(
    { repositories: repos } as any,
    { notify: async (n: any) => { notified.push(n); } } as any,
    {} as any,
  );
  return { service, created, notified };
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
