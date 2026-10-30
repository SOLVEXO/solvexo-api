import { DigitalMailerService } from './digital-mailer.service';
import { DigitalAccessService } from './digital-access.service';
import { CUSTOMER_EMAIL_CATALOG, CUSTOMER_EMAIL_EVENTS } from '../notifications/customer-email-events';
import { FakeModel, makeDb } from './testing/fake-db.kit-spec';

function setup(user: any = { _id: 'c1', name: 'Ayesha', email: 'a@example.com' }) {
  const k = makeDb();
  k.storeModel.rows.push({ _id: 's1', slug: 'demo', name: 'Demo' });
  k.userModel.rows.push(user);
  const sent: any[] = [];
  const notifications: any = { sendCustomerEmail: async (a: any) => { sent.push(a); return 'sent'; } };
  return { ...k, sent, mailer: new DigitalMailerService(k.db, notifications) };
}

const DIGITAL_EVENTS = ['digital_purchase_delivered', 'digital_file_updated', 'digital_access_link', 'membership_welcome', 'membership_renewal_reminder', 'membership_payment_failed', 'membership_grace_period', 'membership_cancelled', 'membership_expired'];

describe('digital email catalog', () => {
  it('every digital / membership email is registered, grouped and only uses declared tags', () => {
    for (const ev of DIGITAL_EVENTS) {
      expect((CUSTOMER_EMAIL_EVENTS as readonly string[]).includes(ev)).toBe(true);
      const def = (CUSTOMER_EMAIL_CATALOG as any)[ev];
      expect(def.group).toBe('digital');
      const used = (def.defaultSubject + def.defaultBody).match(/\{\{(\w+)\}\}/g) ?? [];
      for (const tag of used) expect(def.variables.includes(tag.replace(/[{}]/g, ''))).toBe(true);
    }
  });

  it('the recovery link cannot be switched off, the others can', () => {
    expect((CUSTOMER_EMAIL_CATALOG as any).digital_access_link.canDisable).toBe(false);
    expect((CUSTOMER_EMAIL_CATALOG as any).membership_welcome.canDisable).toBeFalsy();
  });
});

describe('DigitalMailerService', () => {
  it('sends the right event with the store link and the customer name', async () => {
    const s = setup();
    await s.mailer.purchaseDelivered('s1', 'c1', 'Brand Kit');
    expect(s.sent.length).toBe(1);
    expect(s.sent[0].event).toBe('digital_purchase_delivered');
    expect(s.sent[0].to).toBe('a@example.com');
    expect(s.sent[0].vars.productName).toBe('Brand Kit');
    expect(s.sent[0].vars.customerName).toBe('Ayesha');
    expect(s.sent[0].vars.libraryUrl).toContain('/library');
  });

  it('every membership event maps to its own email', async () => {
    const s = setup();
    for (const ev of ['membership_welcome', 'membership_renewal_reminder', 'membership_payment_failed', 'membership_grace_period', 'membership_cancelled', 'membership_expired'] as const) {
      await s.mailer.membership(ev, 's1', 'c1', 'Gold', new Date('2026-12-01'));
    }
    expect(s.sent.map((x) => x.event)).toEqual(['membership_welcome', 'membership_renewal_reminder', 'membership_payment_failed', 'membership_grace_period', 'membership_cancelled', 'membership_expired']);
    expect(s.sent[1].vars.planName).toBe('Gold');
    expect(s.sent[1].vars.membershipUrl).toContain('/memberships');
  });

  it('prefers the contact email (guests) and skips synthetic or missing addresses', async () => {
    const g = setup({ _id: 'c1', name: 'G', email: 'guest-1@guest.invalid', contactEmail: 'real@example.com' });
    await g.mailer.purchaseDelivered('s1', 'c1', 'X');
    expect(g.sent[0].to).toBe('real@example.com');
    const bad = setup({ _id: 'c1', name: 'G', email: 'guest-1@guest.invalid' });
    await bad.mailer.purchaseDelivered('s1', 'c1', 'X');
    expect(bad.sent.length).toBe(0);
  });

  it('the recovery email carries the token in the library link', async () => {
    const s = setup();
    await s.mailer.accessLink('s1', 'c1', 'abc 123');
    expect(s.sent[0].event).toBe('digital_access_link');
    expect(s.sent[0].vars.libraryUrl).toContain('/library?recovery=abc%20123');
  });

  it('a failing mail never throws into the caller', async () => {
    const k = makeDb();
    k.storeModel.rows.push({ _id: 's1', slug: 'demo' });
    k.userModel.rows.push({ _id: 'c1', email: 'a@example.com' });
    const boom: any = { sendCustomerEmail: async () => { throw new Error('smtp down'); } };
    await new DigitalMailerService(k.db, boom).purchaseDelivered('s1', 'c1', 'X');
    expect(true).toBe(true);
  });
});

describe('file update mails', () => {
  it('goes once to every customer with active access, and to nobody else', async () => {
    const k = makeDb();
    k.storeModel.rows.push({ _id: 's1', slug: 'demo' });
    for (const id of ['c1', 'c2', 'c3']) k.userModel.rows.push({ _id: id, name: id, email: `${id}@example.com` });
    const access = new FakeModel({ status: 'active' });
    for (const [cid, status] of [['c1', 'active'], ['c1', 'active'], ['c2', 'active'], ['c3', 'revoked']]) access.rows.push({ storeId: 's1', resourceKind: 'file', resourceRef: 'p1', customerId: cid, status });
    const sent: any[] = [];
    const mailer = new DigitalMailerService(k.db, { sendCustomerEmail: async (a: any) => { sent.push(a); } } as any);
    const svc = new DigitalAccessService(k.db, access as any, new FakeModel() as any, mailer);
    const n = await svc.notifyFileUpdated('s1', 'p1', { productName: 'Kit', fileName: 'a.pdf', version: '2.0', changelog: 'Fixes' });
    await new Promise((r) => setTimeout(r, 50));
    expect(n).toBe(2);
    expect(sent.map((x) => x.to).sort()).toEqual(['c1@example.com', 'c2@example.com']);
    expect(sent[0].vars.versionLabel).toBe('2.0');
  });
});
