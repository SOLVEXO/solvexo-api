/* eslint-disable prettier/prettier */
/**
 * Khata: pure rules + a real-MongoDB run (balance integrity under concurrency, limit, reversal, isolation, idempotency).
 * Real-DB part skipped unless MONGO_TEST_URI is set (needs a replica set for transactions), e.g.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit khata
 */
import mongoose, { Connection } from 'mongoose';
import { KhataService } from './khata.service';
import { KhataRemindersService, reminderText } from './khata-reminders.service';
import { KhataAccountSchema, KhataEntrySchema } from './khata.schema';
import { agingOf, bucketOf, csvCell, exceedsLimit, validateAmount } from './khata-rules.util';

const DAY = 86_400_000;
const now = new Date('2026-03-10T10:00:00Z');
const ago = (d: number) => new Date(now.getTime() - d * DAY);

describe('khata rules', () => {
  it('amount validation', () => {
    expect(validateAmount('12.345')).toBe(12.35);
    expect(() => validateAmount(0)).toThrow();
    expect(() => validateAmount(-5)).toThrow();
    expect(() => validateAmount('abc')).toThrow();
    expect(validateAmount(-5, { allowNegative: true })).toBe(-5);
  });
  it('limit: null = none; exactly at the limit is allowed; credits never exceed', () => {
    expect(exceedsLimit(100, 50, null)).toBe(false);
    expect(exceedsLimit(100, 50, 150)).toBe(false);
    expect(exceedsLimit(100, 50.01, 150)).toBe(true);
    expect(exceedsLimit(500, -50, 100)).toBe(false);
  });
  it('buckets by days past due', () => {
    expect([0, 1, 30, 31, 60, 61, 90, 91].map(bucketOf)).toEqual(['current', 'd1_30', 'd1_30', 'd31_60', 'd31_60', 'd61_90', 'd61_90', 'd90_plus']);
  });
  it('payments are applied to the oldest debits first', () => {
    const r = agingOf([
      { type: 'sale', amount: 100, date: ago(80) }, { type: 'sale', amount: 100, date: ago(40) }, { type: 'sale', amount: 100, date: ago(5) },
      { type: 'payment', amount: -130, date: ago(2) },
    ], now);
    expect(r.buckets).toEqual({ current: 0, d1_30: 100, d31_60: 70, d61_90: 0, d90_plus: 0 });
    expect(r.total).toBe(170);
  });
  it('a due date in the future is current', () => {
    expect(agingOf([{ type: 'sale', amount: 50, date: ago(1), dueDate: new Date(now.getTime() + 5 * DAY) }], now).buckets.current).toBe(50);
  });
  it('csv cells are quoted and formula-guarded', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('=SUM(1)')).toBe("'=SUM(1)");
  });
});

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('KhataService on a real MongoDB', () => {
  let conn: Connection; let svc: KhataService; let acc: any;
  const actor = { id: 'u1', role: 'seller' };
  const S1 = 'store1'; const S2 = 'store2';

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `khata_it_${Date.now()}` }).asPromise();
    const accounts = conn.model('KhataAccount', KhataAccountSchema); const entries = conn.model('KhataEntry', KhataEntrySchema);
    await accounts.init(); await entries.init();
    svc = new KhataService(accounts as any, entries as any, conn as any, { log: async () => undefined } as any);
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });
  beforeEach(async () => { acc = await svc.ensureAccount(S1, { customerId: `c${Math.random()}`, name: 'Ali', currency: 'PKR' }); });

  it('sale then payment keeps a running balance and a gapless sequence', async () => {
    await svc.post(S1, String(acc._id), { type: 'sale', amount: 1000 }, actor);
    const p = await svc.post(S1, String(acc._id), { type: 'payment', amount: 400, method: 'cash' }, actor);
    expect(p.entry.balanceAfter).toBe(600);
    const list = await svc.listEntries(S1, String(acc._id), {});
    expect(list.items.map((e: any) => e.seq)).toEqual([2, 1]);
    expect((await svc.getAccount(S1, String(acc._id))).balance).toBe(600);
  });

  it('20 concurrent postings never lose an update: balance equals the sum of entries', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => svc.post(S1, String(acc._id), { type: i % 2 ? 'payment' : 'sale', amount: 10 + i }, actor)));
    const rows = await svc.listEntries(S1, String(acc._id), { limit: 100 });
    const sum = rows.items.reduce((s: number, e: any) => s + e.amount, 0);
    expect(rows.total).toBe(20);
    expect((await svc.getAccount(S1, String(acc._id))).balance).toBeCloseTo(sum, 2);
    expect(new Set(rows.items.map((e: any) => e.seq)).size).toBe(20);
  }, 60000);

  it('the credit limit blocks a sale above it, even when two arrive together', async () => {
    await svc.setLimit(S1, String(acc._id), 1000, actor);
    const res = await Promise.allSettled([1, 2, 3].map(() => svc.post(S1, String(acc._id), { type: 'sale', amount: 400 }, actor)));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(res.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await svc.getAccount(S1, String(acc._id))).balance).toBe(800);
  });

  it('a reversal restores the balance, only once, and cannot itself be reversed', async () => {
    const s = await svc.post(S1, String(acc._id), { type: 'sale', amount: 300 }, actor);
    const r = await svc.reverse(S1, String(s.entry._id), 'wrong customer', actor);
    expect(r.entry.balanceAfter).toBe(0);
    await expect(svc.reverse(S1, String(s.entry._id), undefined, actor)).rejects.toThrow(/already reversed/);
    await expect(svc.reverse(S1, String(r.entry._id), undefined, actor)).rejects.toThrow(/cannot be reversed/);
    expect((await svc.listEntries(S1, String(acc._id), {})).items.find((e: any) => String(e._id) === String(s.entry._id)).reversed).toBe(true);
    expect((await svc.getAccount(S1, String(acc._id))).balance).toBe(0);
  });

  it('an adjustment needs a note; a payment cannot be negative', async () => {
    await expect(svc.post(S1, String(acc._id), { type: 'adjustment', amount: 50 }, actor)).rejects.toThrow(/note/);
    await expect(svc.post(S1, String(acc._id), { type: 'payment', amount: -5 }, actor)).rejects.toThrow(/valid amount/);
    const a = await svc.post(S1, String(acc._id), { type: 'adjustment', amount: -20, note: 'discount' }, actor);
    expect(a.entry.balanceAfter).toBe(-20);
  });

  it('another store cannot read or post to the account', async () => {
    await expect(svc.getAccount(S2, String(acc._id))).rejects.toThrow(/not found/);
    await expect(svc.post(S2, String(acc._id), { type: 'sale', amount: 5 }, actor)).rejects.toThrow(/not found/);
    await expect(svc.listEntries(S2, String(acc._id), {})).rejects.toThrow(/not found/);
    const e = await svc.post(S1, String(acc._id), { type: 'sale', amount: 5 }, actor);
    await expect(svc.reverse(S2, String(e.entry._id), undefined, actor)).rejects.toThrow(/not found/);
  });

  it('a source key makes automatic entries idempotent, even in parallel', async () => {
    const run = () => svc.post(S1, String(acc._id), { type: 'sale', amount: 70, sourceKey: 'order:abc', source: 'order' }, actor);
    const [a, b] = await Promise.all([run(), run()]);
    expect([a.duplicate, b.duplicate].filter(Boolean)).toHaveLength(1);
    expect((await svc.getAccount(S1, String(acc._id))).balance).toBe(70);
  });

  it('statement: opening balance, closing balance and csv', async () => {
    await svc.post(S1, String(acc._id), { type: 'sale', amount: 500, entryDate: '2026-01-05' }, actor);
    await svc.post(S1, String(acc._id), { type: 'payment', amount: 200, entryDate: '2026-02-10', reference: '=HACK' }, actor);
    const s = await svc.statement(S1, String(acc._id), '2026-02-01', '2026-02-28');
    expect(s.openingBalance).toBe(500); expect(s.closingBalance).toBe(300); expect(s.items).toHaveLength(1);
    const csv = await svc.statementCsv(S1, String(acc._id), '2026-02-01', '2026-02-28');
    expect(csv).toContain('Opening balance'); expect(csv).toContain("'=HACK");
  });

  it('listing only shows this store; totals count what customers owe', async () => {
    const a = await svc.ensureAccount('store3', { customerId: 'y1', name: 'Yan', currency: 'PKR' });
    const b = await svc.ensureAccount('store4', { customerId: 'z1', name: 'Zed', currency: 'PKR' });
    await svc.post('store3', String(a._id), { type: 'sale', amount: 11 }, actor);
    await svc.post('store4', String(b._id), { type: 'sale', amount: 999 }, actor);
    const l = await svc.listAccounts('store3', { owing: 'true' });
    expect(l.items).toHaveLength(1);
    expect(l.totalOwed).toBe(11);
    expect(l.customersOwing).toBe(1);
  });

  describe('mirror of wholesale terms orders', () => {
    let SB = 'storeB2B'; let n = 0;
    let order: any; let mirror: KhataService;
    const accountOf = async () => (await svc.listAccounts(SB, {})).items[0] as any;
    beforeEach(() => {
      SB = `storeB2B${++n}`;
      order = { _id: 'o1', orderNumber: '1001', currency: 'PKR', sellerOrders: [{ storeId: SB }],
        b2b: { companyId: 'comp1', companyName: 'Acme Traders', terms: { type: 'net', netDays: 30 }, dueDate: new Date('2026-05-01'), total: 1000, adjustments: [], payments: [] } };
      const db: any = { repositories: { orderModel: { findById: () => ({ select: () => ({ lean: async () => order }) }) } } };
      mirror = new KhataService(conn.model('KhataAccount') as any, conn.model('KhataEntry') as any, conn as any, { log: async () => undefined } as any, db);
    });
    it('a placed terms order becomes a debit; syncing again changes nothing', async () => {
      await mirror.syncB2BOrder('o1'); await mirror.syncB2BOrder('o1');
      const a = await accountOf();
      expect(a.balance).toBe(1000); expect(a.entryCount).toBe(1);
    });
    it('payments, credit notes and a voided payment follow the order', async () => {
      await mirror.syncB2BOrder('o1');
      order.b2b.payments.push({ _id: 'p1', amount: 300, method: 'bank', reference: 'TT1', date: new Date(), voided: false });
      await mirror.syncB2BOrder('o1');
      expect((await accountOf()).balance).toBe(700);
      order.b2b.total = 900; order.b2b.adjustments.push({ amount: -100, note: 'Return of 1 item(s)', date: new Date() });
      await mirror.syncB2BOrder('o1');
      expect((await accountOf()).balance).toBe(600);
      order.b2b.payments[0].voided = true;
      await mirror.syncB2BOrder('o1'); await mirror.syncB2BOrder('o1');
      expect((await accountOf()).balance).toBe(900);
    });
    it('a limit set by the seller never stops the mirror of an order already placed', async () => {
      await mirror.syncB2BOrder('o1');
      const a = await accountOf();
      await svc.setLimit(SB, String(a._id), 100, actor);
      order._id = 'o2'; order.b2b.total = 500;
      await mirror.syncB2BOrder('o2');
      expect((await accountOf()).balance).toBe(1500);
    });
    it('orders without terms and other currencies are not mirrored', async () => {
      order.b2b.terms = null; await mirror.syncB2BOrder('o1');
      expect((await svc.listAccounts(SB, {})).total).toBe(0);
    });
  });

  describe('POS udhaar', () => {
    let sale: any; let pos: KhataService; let store: string; let n = 0;
    beforeEach(() => {
      store = `storePos${++n}`;
      sale = { _id: '665f1f77bcf86cd799439011', status: 'completed', paymentMethod: 'other', total: 250, currency: 'PKR', customerId: null, saleNumber: 'POS-00007' };
      const db: any = { repositories: { saleModel: { findOne: (q: any) => ({ select: () => ({ lean: async () => (q.storeId === store ? sale : null) }) }) } } };
      pos = new KhataService(conn.model('KhataAccount') as any, conn.model('KhataEntry') as any, conn as any, { log: async () => undefined } as any, db);
    });
    const mk = () => pos.ensureAccount(store, { customerId: 'cust1', name: 'Bilal', currency: 'PKR' });
    it('puts a finished sale on the account once; the limit applies', async () => {
      const a: any = await mk();
      await pos.putPosSaleOnAccount(store, sale._id, String(a._id), actor);
      const again = await pos.putPosSaleOnAccount(store, sale._id, String(a._id), actor);
      expect(again.duplicate).toBe(true);
      expect((await pos.getAccount(store, String(a._id))).balance).toBe(250);
      await pos.setLimit(store, String(a._id), 300, actor);
      sale._id = '665f1f77bcf86cd799439012';
      await expect(pos.putPosSaleOnAccount(store, sale._id, String(a._id), actor)).rejects.toThrow(/credit limit/);
    });
    it('refuses sales that are not "other" tender, not completed, or of another store/customer', async () => {
      const a: any = await mk();
      sale.paymentMethod = 'cash'; await expect(pos.putPosSaleOnAccount(store, sale._id, String(a._id), actor)).rejects.toThrow(/Other/);
      sale.paymentMethod = 'other'; sale.status = 'held'; await expect(pos.putPosSaleOnAccount(store, sale._id, String(a._id), actor)).rejects.toThrow(/completed/);
      sale.status = 'completed'; sale.customerId = 'someone-else'; await expect(pos.putPosSaleOnAccount(store, sale._id, String(a._id), actor)).rejects.toThrow(/different customer/);
      await expect(pos.putPosSaleOnAccount('otherStore', sale._id, String(a._id), actor)).rejects.toThrow(/not found/);
    });
    it('a voided sale can be taken off the account, once', async () => {
      const a: any = await mk();
      await pos.putPosSaleOnAccount(store, sale._id, String(a._id), actor);
      await expect(pos.releasePosSale(store, sale._id, actor)).rejects.toThrow(/voided or fully refunded/);
      sale.status = 'voided';
      await pos.releasePosSale(store, sale._id, actor);
      expect((await pos.getAccount(store, String(a._id))).balance).toBe(0);
      await expect(pos.releasePosSale(store, sale._id, actor)).rejects.toThrow(/already reversed/);
    });
  });

  describe('SMS reminder', () => {
    let consent: any; let sms: any; let rem: KhataRemindersService; let store: string; let n = 0; let id: string;
    beforeEach(async () => {
      process.env.MESSAGING_CAMPAIGNS_ENABLED = 'true';
      store = `storeRem${++n}`;
      consent = { statusFor: jest.fn(async () => new Map([['923001234567', 'opted_in']])) };
      sms = { activeConfig: jest.fn(async () => ({ dailyLimit: 10 })), sendMarketing: jest.fn(async () => ({ success: true })) };
      const db: any = { repositories: { storeModel: { findById: () => ({ select: () => ({ lean: async () => ({ name: 'Shop' }) }) }) } } };
      rem = new KhataRemindersService(conn.model('KhataAccount') as any, consent, sms, db);
      const a: any = await svc.ensureAccount(store, { customerId: 'c', name: 'Cara', phone: '0300 1234567', currency: 'PKR' });
      id = String(a._id);
      await svc.post(store, id, { type: 'sale', amount: 800 }, actor);
    });
    afterAll(() => { delete process.env.MESSAGING_CAMPAIGNS_ENABLED; });
    it('sends one SMS to an opted-in customer and not a second one within a day', async () => {
      await rem.remind(store, id);
      expect(sms.sendMarketing).toHaveBeenCalledTimes(1);
      expect(sms.sendMarketing.mock.calls[0][2]).toContain('800');
      await expect(rem.remind(store, id)).rejects.toThrow(/last 24 hours/);
    });
    it('no consent, no gateway, nothing owed, flag off: nothing is sent', async () => {
      consent.statusFor.mockResolvedValueOnce(new Map());
      await expect(rem.remind(store, id)).rejects.toThrow(/not agreed/);
      sms.activeConfig.mockResolvedValueOnce(null);
      await expect(rem.remind(store, id)).rejects.toThrow(/not switched on/);
      process.env.MESSAGING_CAMPAIGNS_ENABLED = 'false';
      await expect(rem.remind(store, id)).rejects.toThrow(/not available/);
      process.env.MESSAGING_CAMPAIGNS_ENABLED = 'true';
      await svc.post(store, id, { type: 'payment', amount: 800 }, actor);
      await expect(rem.remind(store, id)).rejects.toThrow(/owes nothing/);
      expect(sms.sendMarketing).not.toHaveBeenCalled();
    });
    it('a failed send does not use up the daily reminder', async () => {
      sms.sendMarketing.mockResolvedValueOnce({ success: false, error: 'timeout' });
      await expect(rem.remind(store, id)).rejects.toThrow(/not sent/);
      await rem.remind(store, id);
      expect(sms.sendMarketing).toHaveBeenCalledTimes(2);
    });
    it('reminder text names the store and the amount', () => { expect(reminderText('Shop', 1234.5, 'PKR')).toContain('PKR 1,234.5'); });
  });
});
