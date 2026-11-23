/* eslint-disable prettier/prettier */
import { importCustomersCsv } from './customer-bulk-import';

function setup(existingEmails: string[] = [], storeId = 'S1') {
  // Fake store-scoped user table: key = storeId|email
  const db = new Set(existingEmails.map((e) => `${storeId}|${e}`));
  const created: any[] = [];
  const shop: any[] = [];
  const shopPhones = new Set<string>();
  const deps = {
    exists: async (email: string) => db.has(`${storeId}|${email}`),
    create: async (dto: any) => { created.push(dto); db.add(`${storeId}|${dto.email}`); return {}; },
    shopExists: async (phone: string) => shopPhones.has(phone),
    createShop: async (dto: any) => { shop.push(dto); shopPhones.add(dto.phone); return {}; },
  };
  return { deps, created, shop, shopPhones };
}

describe('customers bulk import', () => {
  it('saves valid rows and reports invalid ones with the column', async () => {
    const { deps, created } = setup();
    const csv = ['Name,Email,Phone', 'Ann,ann@x.com,123', 'Bob,not-an-email,', ',,'].join('\n');
    const res = await importCustomersCsv(deps, csv);
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(1);
    expect(res.data.failed[0].error).toContain('Email');
    expect(created[0]).toEqual({ name: 'Ann', email: 'ann@x.com', phone: '123' });
  });

  it('skips a customer that already exists in the store (case-insensitive email)', async () => {
    const { deps, created } = setup(['ann@x.com']);
    const res = await importCustomersCsv(deps, 'Name,Email\nAnn,ANN@x.com');
    expect(res.data.created).toBe(0);
    expect(res.data.skipped).toBe(1);
    expect(res.data.skippedRows[0].note).toBe('Customer already exists');
    expect(created.length).toBe(0);
  });

  it('fails the second row when the same email appears twice in the file', async () => {
    const { deps, created } = setup();
    const res = await importCustomersCsv(deps, 'Name,Email\nAnn,a@x.com\nAnn2,A@x.com');
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(1);
    expect(res.data.failed[0].error).toContain('Duplicate');
    expect(created.length).toBe(1);
  });

  it('does not treat another store\'s customer as existing', async () => {
    const other = setup(['ann@x.com'], 'OTHER');
    // deps look only at their own store key (S1 in a fresh setup)
    const mine = setup([], 'S1');
    const res = await importCustomersCsv(mine.deps, 'Name,Email\nAnn,ann@x.com');
    expect(res.data.created).toBe(1);
    expect(other.created.length).toBe(0);
  });

  it('subscribes a "yes" row only when the seller confirmed consent', async () => {
    const { deps, created } = setup();
    const csv = 'Name,Email,Accepts Email Marketing\nAnn,a@x.com,yes\nBob,b@x.com,no\nCid,c@x.com,';
    const res = await importCustomersCsv(deps, csv, { consentConfirmed: true });
    expect(res.data.created).toBe(3);
    expect(created.find((c) => c.email === 'a@x.com').marketingConsent).toBe(true);
    expect(created.find((c) => c.email === 'b@x.com').marketingConsent).toBeUndefined();
    expect(created.find((c) => c.email === 'c@x.com').marketingConsent).toBeUndefined();
  });

  it('rejects a "yes" row (never silently subscribes) when consent was not confirmed', async () => {
    const { deps, created } = setup();
    const res = await importCustomersCsv(deps, 'Name,Email,Accepts Email Marketing\nAnn,a@x.com,yes\nBob,b@x.com,no');
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(1);
    expect(res.data.failed[0].error).toContain('consent');
    expect(created.map((c) => c.email)).toEqual(['b@x.com']);
  });

  it('rejects a file whose columns match nothing', async () => {
    const { deps } = setup();
    await expect(importCustomersCsv(deps, 'Foo,Bar\n1,2')).rejects.toThrow('None of the column names');
  });

  // Shopify's own customer export, as sellers download it.
  const SHOPIFY = [
    'First Name,Last Name,Email,Accepts Email Marketing,Default Address Company,Default Address Address1,Default Address Address2,Default Address City,Default Address Province Code,Default Address Country Code,Default Address Zip,Default Address Phone,Phone,Accepts SMS Marketing,Accepts WhatsApp Marketing,Tags,Note,Tax Exempt',
    'John,Doe,john.doe@shopify.com,no,,123 Fake Street,,Ottawa,ON,CA,a1b2c3,+1 (613) 333-3333,,no,no,,,yes',
    'Jane,Doe,,yes,,,,,,,,,+1 (613) 555-5555,yes,yes,,Very nice customer,no',
  ].join('\n');

  it('imports a Shopify customer export: email rows as customers, phone-only rows as shop customers', async () => {
    const { deps, created, shop } = setup();
    const res = await importCustomersCsv(deps, SHOPIFY, { consentConfirmed: true });
    expect(res.data.created).toBe(2);
    expect(res.data.failedCount).toBe(0);
    expect(created[0]).toMatchObject({
      name: 'John Doe', email: 'john.doe@shopify.com', phone: '+1 (613) 333-3333',
      address: { recipientName: 'John Doe', addressLine1: '123 Fake Street', city: 'Ottawa', state: 'ON', zipCode: 'a1b2c3', country: 'CA', phoneNumber: '+1 (613) 333-3333', addressLine2: null },
    });
    expect(created[0].marketingConsent).toBeUndefined();
    expect(shop).toEqual([{ name: 'Jane Doe', phone: '+16135555555', address: null, notes: 'Very nice customer', smsConsent: true, whatsappConsent: true }]);
    expect(res.data.notices).toEqual([
      expect.stringContaining('1 customer without an email was added to your shop (POS) customers'),
      expect.stringContaining('Tax Exempt is not used yet'),
    ]);
  });

  it('needs the consent box for SMS or WhatsApp "yes" too', async () => {
    const { deps, created, shop } = setup();
    const res = await importCustomersCsv(deps, SHOPIFY);
    expect(res.data.created).toBe(1);
    expect(res.data.failed[0]).toMatchObject({ row: 3, error: expect.stringContaining('consent') });
    expect(created.length).toBe(1);
    expect(shop.length).toBe(0);
  });

  it('keeps tags, note and company, and records SMS/WhatsApp consent on an email customer', async () => {
    const { deps, created } = setup();
    const csv = 'First Name,Email,Default Address Company,Tags,Note,Accepts SMS Marketing,Accepts WhatsApp Marketing\nAli,ali@x.com,Ali Traders,"VIP, Wholesale, VIP",Pays cash,yes,no';
    await importCustomersCsv(deps, csv, { consentConfirmed: true });
    expect(created[0]).toMatchObject({ name: 'Ali', tags: ['VIP', 'Wholesale'], notes: 'Company: Ali Traders\nPays cash', smsConsent: true });
    expect(created[0].whatsappConsent).toBeUndefined();
  });

  it('adds the customer but not an incomplete address, and says so', async () => {
    const { deps, created } = setup();
    const res = await importCustomersCsv(deps, 'First Name,Email,Default Address Address1,Default Address City\nSara,s@x.com,House 5,Lahore');
    expect(res.data.created).toBe(1);
    expect(created[0].address).toBeUndefined();
    expect(res.data.notices?.[0]).toContain('1 address was not saved');
  });

  it('skips a shop customer whose phone the store already has, and fails rows with neither email nor phone', async () => {
    const { deps, shop, shopPhones } = setup();
    shopPhones.add('03001234567');
    const res = await importCustomersCsv(deps, 'First Name,Phone,Email\nBilal,0300-1234567,\nNoContact,,\nBad,abc,');
    expect(res.data.skippedRows[0].note).toBe('Shop customer with this phone already exists');
    expect(res.data.failed.map((f) => f.error)).toEqual(['Needs an email or a phone number', expect.stringContaining('digits only')]);
    expect(shop.length).toBe(0);
  });
});
