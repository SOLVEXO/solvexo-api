/* eslint-disable prettier/prettier */
/**
 * Wholesale invoice reminders: the schedule (pure) and a real-MongoDB run (claim, recipients, store isolation).
 * The real-DB part is skipped unless MONGO_TEST_URI is set, e.g.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit b2b-reminders
 */
import mongoose, { Connection, Types } from 'mongoose';
import { B2BRemindersService, nextReminder } from './b2b-reminders.service';
import { B2BBuyerSchema } from './b2b.schema';
import { OrderSchema } from '../orders/schemas/order.schema';
import { CUSTOMER_EMAIL_CATALOG, CUSTOMER_EMAIL_SAMPLE_VARS } from '../notifications/customer-email-events';

const DAY = 86_400_000;
const now = new Date('2026-03-10T10:00:00Z');
const in_ = (days: number) => new Date(now.getTime() + days * DAY);

describe('nextReminder schedule', () => {
  it('one "due soon" within 3 days of the due date, none earlier, none twice', () => {
    expect(nextReminder(in_(10), 100, [], now)).toBeNull();
    expect(nextReminder(in_(2), 100, [], now)).toBe('due_soon');
    expect(nextReminder(in_(2), 100, [{ kind: 'due_soon', at: now }], now)).toBeNull();
  });
  it('overdue: first one at once, then weekly, at most 4', () => {
    expect(nextReminder(in_(-1), 100, [], now)).toBe('overdue');
    expect(nextReminder(in_(-1), 100, [{ kind: 'overdue', at: in_(-3) }], now)).toBeNull();
    expect(nextReminder(in_(-30), 100, [{ kind: 'overdue', at: in_(-7) }], now)).toBe('overdue');
    const four = [28, 21, 14, 7].map((d) => ({ kind: 'overdue' as const, at: in_(-d) }));
    expect(nextReminder(in_(-60), 100, four, now)).toBeNull();
  });
  it('nothing is sent when nothing is owed or there is no due date', () => {
    expect(nextReminder(in_(-5), 0, [], now)).toBeNull();
    expect(nextReminder(null, 100, [], now)).toBeNull();
  });
});

describe('the b2b_invoice_reminder email event', () => {
  it('is registered, enabled by default, and every tag in its text has a sample value', () => {
    const def = CUSTOMER_EMAIL_CATALOG.b2b_invoice_reminder;
    expect(def).toBeTruthy();
    expect(def.defaultEnabled).not.toBe(false);
    const tags = new Set([...(def.defaultSubject + def.defaultBody).matchAll(/{{(\w+)}}/g)].map((m) => m[1]));
    // storeName is filled by the preview itself, every other tag needs a sample value.
    for (const t of tags) { expect(def.variables).toContain(t); if (t !== 'storeName') expect(CUSTOMER_EMAIL_SAMPLE_VARS[t]).toBeDefined(); }
  });
});

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('B2BRemindersService.sendDue on a real MongoDB', () => {
  let conn: Connection;
  let repos: any;
  let svc: B2BRemindersService;
  const send = jest.fn().mockResolvedValue(undefined);
  const oid = () => new Types.ObjectId();
  const STORE = String(oid());
  const OTHER = String(oid());

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `b2brem_it_${Date.now()}` }).asPromise();
    repos = {
      orderModel: conn.model('Order', OrderSchema),
      userModel: conn.model('User', new mongoose.Schema({}, { strict: false })),
      storeModel: conn.model('Store', new mongoose.Schema({}, { strict: false })),
    };
    const buyers = conn.model('B2BBuyer', B2BBuyerSchema);
    await repos.storeModel.collection.insertOne({ _id: new Types.ObjectId(STORE), slug: 'shop-a' });
    svc = new B2BRemindersService({ repositories: repos } as any, {} as any, { sendCustomerEmail: send } as any, buyers as any);
    (svc as any).buyersModel = buyers;
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  const user = async (storeId: string, email: string, extra: any = {}) => String((await repos.userModel.collection.insertOne({ storeId, email, name: email.split('@')[0], ...extra })).insertedId);
  const termsOrder = async (userId: string, due: Date, over: any = {}) => {
    const _id = oid();
    await repos.orderModel.collection.insertOne({
      _id, userId, isDelete: false, orderNumber: 'ORD-' + _id, orderStatus: 'pending', currency: 'PKR', paymentType: 'b2b_terms', isPaid: false,
      sellerOrders: [{ storeId: STORE }],
      b2b: { companyId: 'c1', companyName: 'Acme', locationId: 'loc1', poNumber: 'PO-5', terms: { type: 'net', netDays: 30 }, dueDate: due, total: 1000, currency: 'PKR', depositRequired: 0, paidTotal: 0, payments: [], status: 'unpaid', ...over },
    });
    return _id;
  };

  it('mails the orderer and the location admins once, and claims the reminder so a second run sends nothing', async () => {
    send.mockClear();
    const orderer = await user(STORE, 'orderer@acme.com');
    const admin = await user(STORE, 'admin@acme.com');
    await user(STORE, 'other-location-admin@acme.com');
    await conn.model('B2BBuyer').create([
      { storeId: STORE, companyId: 'c1', locationId: 'loc1', userId: admin, email: 'admin@acme.com', role: 'location_admin' },
      { storeId: STORE, companyId: 'c1', locationId: 'loc2', userId: String(oid()), email: 'other-location-admin@acme.com', role: 'location_admin' },
    ]);
    const id = await termsOrder(orderer, new Date(Date.now() - 2 * DAY));

    expect(await svc.sendDue()).toBe(1);
    const to = send.mock.calls.map((c) => c[0].to).sort();
    expect(to).toEqual(['admin@acme.com', 'orderer@acme.com']);
    expect(send.mock.calls[0][0]).toMatchObject({ event: 'b2b_invoice_reminder', storeId: STORE });
    expect(send.mock.calls[0][0].vars).toMatchObject({ poNumber: 'PO-5', amountDue: expect.stringContaining('1,000') });
    const o: any = await repos.orderModel.collection.findOne({ _id: id });
    expect(o.b2b.remindersSent).toHaveLength(1);
    expect(o.b2b.remindersSent[0].kind).toBe('overdue');

    send.mockClear();
    expect(await svc.sendDue()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('skips paid, cancelled, guest-only and not-yet-due orders; counts only what is still owed', async () => {
    send.mockClear();
    const u = await user(STORE, 'skip@acme.com');
    const guest = await user(STORE, 'guest@acme.com', { isGuest: true });
    await termsOrder(u, new Date(Date.now() - DAY), { status: 'paid', paidTotal: 1000, payments: [{ _id: 1, amount: 1000 }] });
    const cancelled = await termsOrder(u, new Date(Date.now() - DAY));
    await repos.orderModel.collection.updateOne({ _id: cancelled }, { $set: { orderStatus: 'cancelled' } });
    await termsOrder(u, new Date(Date.now() + 30 * DAY));
    const guestOrder = await termsOrder(guest, new Date(Date.now() - DAY), { locationId: 'loc9' });

    await svc.sendDue();
    expect(send).not.toHaveBeenCalled();
    // The guest order was claimed (a reminder was "sent" to nobody) rather than retried every hour.
    expect(((await repos.orderModel.collection.findOne({ _id: guestOrder })) as any).b2b.remindersSent).toHaveLength(1);
  });

  it('a due-soon order gets the due-soon wording', async () => {
    send.mockClear();
    const u = await user(STORE, 'soon@acme.com');
    await termsOrder(u, new Date(Date.now() + 2 * DAY));
    await svc.sendDue();
    const call = send.mock.calls.find((c) => c[0].to === 'soon@acme.com');
    expect(call?.[0].vars.reminderNote).toMatch(/due soon/);
  });
});
