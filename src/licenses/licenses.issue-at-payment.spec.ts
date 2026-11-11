process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY || 'spec-only-key';
import { LicensesService } from './licenses.service';
import { FakeModel, FakeRedis, digitalProduct, makeDb, paidOrder } from '../digital-access/testing/fake-db.kit-spec';

function setup(orderOver: any = {}) {
  const k = makeDb();
  const keys = new FakeModel({ status: 'active', activations: [] });
  k.orderModel.rows.push(paidOrder(orderOver));
  k.productModel.rows.push(digitalProduct({ digital: { ...digitalProduct().digital, licenseKeys: { enabled: true, activationLimit: 2 } } }));
  const svc = new LicensesService(k.db, new FakeRedis() as any, keys as any);
  return { ...k, keys, svc };
}

describe('license keys are issued when the order is paid', () => {
  it('the key exists at once, before the buyer ever opens /licenses', async () => {
    const s = setup();
    expect(s.keys.rows.length).toBe(0);
    expect(await s.svc.issueForOrder('o1')).toBe(1);
    expect(s.keys.rows.length).toBe(1);
    expect(s.keys.rows[0].customerId).toBe('c1');
    expect(s.keys.rows[0].activationLimit).toBe(2);
  });

  it('is idempotent: the hook running twice, or the buyer opening /licenses afterwards, never makes a second key', async () => {
    const s = setup();
    await s.svc.issueForOrder('o1');
    expect(await s.svc.issueForOrder('o1')).toBe(0);
    await s.svc.listMine('s1', 'c1');
    expect(s.keys.rows.length).toBe(1);
  });

  it('an unpaid order gets no key', async () => {
    const s = setup({ isPaid: false });
    expect(await s.svc.issueForOrder('o1')).toBe(0);
    expect(s.keys.rows.length).toBe(0);
  });

  it('a cancelled item gets no key', async () => {
    const s = setup({ sellerOrders: [{ storeId: 's1', items: [{ _id: 'i1', type: 'digital', productId: 'p1', status: 'cancelled' }] }] });
    expect(await s.svc.issueForOrder('o1')).toBe(0);
  });
});

describe('the license key is e-mailed to the buyer when the order is paid', () => {
  function withMailer(orderOver: any = {}) {
    const s = setup(orderOver);
    const sent: any[] = [];
    const mailer: any = { licenseKeyIssued: async (...a: any[]) => { sent.push(a); } };
    const svc = new LicensesService(s.db, new FakeRedis() as any, s.keys as any, mailer);
    return { ...s, svc, sent };
  }

  it('sends the key once, with the product name and the device limit', async () => {
    const s = withMailer();
    await s.svc.issueForOrder('o1');
    expect(s.sent.length).toBe(1);
    const [storeId, customerId, , key, limit] = s.sent[0];
    expect(storeId).toBe('s1');
    expect(customerId).toBe('c1');
    expect(limit).toBe(2);
    expect(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(key)).toBe(true);
  });

  it('the mailed key is the real one (it validates against the stored hash)', async () => {
    const s = withMailer();
    await s.svc.issueForOrder('o1');
    const { hashKey } = require('./license-key.util');
    expect(hashKey(s.sent[0][3])).toBe(s.keys.rows[0].keyHash);
  });

  it('the hook running again sends no second mail', async () => {
    const s = withMailer();
    await s.svc.issueForOrder('o1');
    await s.svc.issueForOrder('o1');
    expect(s.sent.length).toBe(1);
  });

  it('a key created later because the buyer opened /licenses is not mailed', async () => {
    const s = withMailer();
    await s.svc.listMine('s1', 'c1');
    expect(s.keys.rows.length).toBe(1);
    expect(s.sent.length).toBe(0);
  });

  it('a mail that fails never fails the purchase', async () => {
    const s = setup();
    const mailer: any = { licenseKeyIssued: async () => { throw new Error('smtp down'); } };
    const svc = new LicensesService(s.db, new FakeRedis() as any, s.keys as any, mailer);
    expect(await svc.issueForOrder('o1')).toBe(1);
    expect(s.keys.rows.length).toBe(1);
  });
});

import { CUSTOMER_EMAIL_CATALOG } from '../notifications/customer-email-events';
import { CUSTOMER_EMAIL_DEFAULTS_BY_LOCALE } from '../notifications/customer-email-locales';

describe('the license key email text', () => {
  it('the device limit is a number the text can put in any language', () => {
    expect(CUSTOMER_EMAIL_CATALOG.license_key_issued.variables).toContain('activationLimit');
    expect(CUSTOMER_EMAIL_CATALOG.license_key_issued.defaultBody).toContain('{{activationLimit}}');
  });
  it('has an Urdu default that uses only tags the event allows', () => {
    const ur = (CUSTOMER_EMAIL_DEFAULTS_BY_LOCALE as any).ur.license_key_issued;
    expect(!!ur).toBe(true);
    const allowed = new Set(CUSTOMER_EMAIL_CATALOG.license_key_issued.variables);
    for (const text of [ur.subject, ur.body]) {
      for (const m of String(text).matchAll(/\{\{\s*(\w+)\s*\}\}/g)) expect(allowed.has(m[1])).toBe(true);
    }
    expect(ur.body).toContain('{{licenseKey}}');
  });
  it('the mailer sends the device limit as a plain number', async () => {
    const sent: any[] = [];
    const { DigitalMailerService } = require('../digital-access/digital-mailer.service');
    const db: any = { repositories: { storeModel: new FakeModel(), userModel: new FakeModel() } };
    db.repositories.storeModel.rows.push({ _id: 's1', slug: 'shop', name: 'Shop' });
    db.repositories.userModel.rows.push({ _id: 'c1', name: 'Sana', email: 'sana@x.com' });
    const svc = new DigitalMailerService(db, { sendCustomerEmail: async (a: any) => { sent.push(a); } } as any);
    await svc.licenseKeyIssued('s1', 'c1', 'App', 'AAAA-BBBB-CCCC-DDDD', 3);
    expect(sent[0].event).toBe('license_key_issued');
    expect(sent[0].vars.activationLimit).toBe('3');
    expect(sent[0].vars.licenseKey).toBe('AAAA-BBBB-CCCC-DDDD');
  });
});
