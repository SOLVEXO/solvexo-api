/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { randomBytes } from 'crypto';
import * as schema from '@/database/schema';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosCustomerCore } from './pos-customer-core.service';
import { PosCustomersService } from './pos-customers.service';
import { PosReprintService } from './pos-reprint.service';
import { PosReceiptService } from './pos-receipt.service';
import { PosStoreSettingsService } from './pos-store-settings.service';
import { CLIENT_LINK_WINDOW_MS, SYNCING_PAGE } from './pos-receipt-link.util';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';
import { StoreCreditService } from '../store-credit/store-credit.service';
import { StoreCreditTransactionSchema } from '../store-credit/schemas/store-credit-transaction.schema';

/** G4.9 on a real replica-set MongoDB: the loyalty balance after a sale, original vs reprint for documents, the offline-buildable receipt link. */
jest.setTimeout(300_000);
let h: MongoHarness; let svc: PosService; let r: any; let cust: PosCustomersService; let reprints: PosReprintService; let receipts: PosReceiptService; let st: PosStoreSettingsService;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  process.env.STORE_CREDIT_LEDGER = 'new';
  h = await startMongoHarness();
  Object.assign(h.repos, {
    loyaltyProgramModel: h.conn.model(schema.LoyaltyProgram.name, schema.LoyaltyProgramSchema), loyaltyMemberModel: h.conn.model(schema.LoyaltyMember.name, schema.LoyaltyMemberSchema), loyaltyTransactionModel: h.conn.model(schema.LoyaltyTransaction.name, schema.LoyaltyTransactionSchema),
    storeCreditTransactionModel: h.conn.model('StoreCreditTransaction', StoreCreditTransactionSchema),
    posReprintEventModel: h.conn.model(schema.PosReprintEvent.name, schema.PosReprintEventSchema),
  });
  r = h.repos;
  const dbs: any = { repositories: r };
  const credit = new StoreCreditService(dbs, { log: jest.fn() } as any, { notify: jest.fn().mockResolvedValue(undefined) } as any);
  const core = new PosCustomerCore(dbs, credit);
  svc = new PosService(dbs, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any, undefined, undefined, core);
  const auth = new PosAuthorizer(dbs, svc);
  cust = new PosCustomersService(dbs, svc, auth, core);
  reprints = new PosReprintService(dbs, svc, auth);
  receipts = new PosReceiptService(dbs, svc);
  st = new PosStoreSettingsService(dbs, svc, auth);
  await r.posReprintEventModel.init();
});
afterAll(async () => { delete process.env.STORE_CREDIT_LEDGER; await h?.stop(); });

type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const dev = (s: Seed, who: 'manager' | 'cashier' = 'manager') => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } }, headers: { 'x-pos-employee-token': tok(s, who) }, params: { storeId: s.storeId }, query: {} });
const owner = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller' }, headers: {}, params: { storeId: s.storeId }, query: {} });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };
const key = (at = Date.now()) => `pos-${at * 1000}-${randomBytes(12).toString('hex')}`;

async function fresh() {
  const s = await seedStore(h, { stock: 200, price: 10, baseCurrency: 'USD' });
  const sid = String(new Types.ObjectId());
  await r.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sid), storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date(Date.now() - 7_200_000), openingCash: 50, totalSales: 0, totalTransactions: 0 });
  const sell = async (qty: number, over: any = {}) => ((await svc.createSale(s.sellerId, { storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.cashierId, items: [{ productId: s.productId, variantId: s.variantId, qty }], paymentMethod: 'cash', ...over } as any, tok(s, 'manager'))) as any).data;
  const person = async () => (await cust.create(dev(s), s.storeId, { name: 'Ayesha Khan', phone: '03001234567' }, { employee: tok(s, 'cashier') })).data;
  const loyalty = async (e: number | null, v: number | null) => r.loyaltyProgramModel.updateOne({ storeId: s.storeId }, { $set: { isEnabled: true, posEarnSpendMinor: e, posRedeemMinorPerPoint: v, tiers: [] } }, { upsert: true });
  const points = async (id: string) => (await r.loyaltyMemberModel.findOne({ storeId: s.storeId, userId: id }).lean())?.pointsBalance ?? 0;
  return { s, sid, sell, person, loyalty, points };
}

describe('G4.9 · loyalty balance after the sale (from the ledger, same transaction)', () => {
  it('an online sale with a customer stores the balance after earning / redeeming; it matches the ledger; the stored sale has it too', async () => {
    const f = await fresh();
    const c: any = await f.person(); await f.loyalty(1000, 100); // 1 point per 10.00; a point is worth 1.00
    const a = await f.sell(5, { customerId: c.id, amountTendered: 50 }); // +5
    expect(a.loyaltyBalanceAfterPoints).toBe(5);
    const b = await f.sell(2, { customerId: c.id, redeemPoints: 3, amountTendered: 20 }); // −3, earns floor(17/10)=1 → 3
    expect(b.loyaltyBalanceAfterPoints).toBe(3);
    expect(await f.points(c.id)).toBe(3);
    const last: any = await r.loyaltyTransactionModel.findOne({ storeId: f.s.storeId, userId: c.id }).sort({ _id: -1 }).lean();
    expect(last.balanceAfter).toBe(3);
    expect((await r.saleModel.findById(b._id).lean()).loyaltyBalanceAfterPoints).toBe(3);
  });

  it('a customer sale that earns nothing still carries the balance (read in the transaction); a walk-in, loyalty off and an offline replay do not', async () => {
    const f = await fresh();
    const c: any = await f.person(); await f.loyalty(1000, null);
    await f.sell(3, { customerId: c.id, amountTendered: 30 }); // 3 points
    await f.loyalty(null, null); // program on, no earn rate → earns 0
    expect((await f.sell(1, { customerId: c.id, amountTendered: 10 })).loyaltyBalanceAfterPoints).toBe(3);
    expect((await f.sell(1)).loyaltyBalanceAfterPoints).toBeUndefined();
    await r.loyaltyProgramModel.updateOne({ storeId: f.s.storeId }, { $set: { isEnabled: false } });
    expect((await f.sell(1, { customerId: c.id, amountTendered: 10 })).loyaltyBalanceAfterPoints).toBeUndefined();
    await f.loyalty(1000, null);
    const off = await f.sell(2, { customerId: c.id, amountTendered: 20, offline: true, clientCreatedAt: new Date(Date.now() - 3_600_000).toISOString(), idempotencyKey: key() });
    expect(off.isOffline).toBe(true);
    expect(off.loyaltyBalanceAfterPoints).toBeUndefined();
    expect(await f.points(c.id)).toBe(5); // the offline sale still earned at sync
  });

  it('a held sale completed online gets the balance when it is paid', async () => {
    const f = await fresh();
    const c: any = await f.person(); await f.loyalty(1000, null);
    const held = await f.sell(2, { customerId: c.id, status: 'held' });
    expect(held.loyaltyBalanceAfterPoints).toBeUndefined();
    const done: any = (await svc.completeSale(f.s.sellerId, String(held._id), { paymentMethod: 'cash', amountTendered: 20 } as any, tok(f.s, 'manager'))).data;
    expect(done.loyaltyBalanceAfterPoints ?? (await r.saleModel.findById(held._id).lean()).loyaltyBalanceAfterPoints).toBe(2);
    expect((await r.saleModel.findById(held._id).lean()).loyaltyBalanceAfterPoints).toBe(2);
  });
});

describe('G4.9 · original vs reprint for documents', () => {
  async function withSale(s: Seed) {
    const id = new Types.ObjectId();
    await r.saleModel.collection.insertOne({ _id: id, storeId: s.storeId, saleNumber: 'S-0001', status: 'completed', items: [], total: 5, invoice: { number: 'INV-1' }, createdAt: new Date() });
    const cn = new Types.ObjectId();
    await r.posCreditNoteModel.collection.insertOne({ _id: cn, storeId: s.storeId, saleId: String(id), number: 'CN-0001', seq: 1, lines: [], tenders: [], createdAt: new Date() });
    return { sale: String(id), cn: String(cn) };
  }
  const print = (s: Seed, who: 'manager' | 'cashier', body: any, approver?: string) => reprints.reprint(dev(s, who), s.storeId, body, { employee: tok(s, who), ...(approver ? { approver } : {}) });

  it('the first print of a tax invoice and of a credit note is the ORIGINAL (no PIN even when required, audited as printed); later prints are reprint #1, #2', async () => {
    const f = await fresh(); const s = f.s; const d = await withSale(s);
    await st.update(owner(s) as any, s.storeId, { security: { requirePinForReprint: true } }, {});
    let docs: any = await receipts.documentsOf(s.sellerId, d.sale);
    expect([docs.data.invoice.printed, docs.data.creditNotes[0].printed]).toEqual([false, false]);
    for (const [type, id] of [['invoice', d.sale], ['credit_note', d.cn]] as const) {
      const o: any = await print(s, 'cashier', { documentType: type, documentId: id, kind: 'original' });
      expect([o.data.kind, o.data.reprintNumber, o.data.approvedBy]).toEqual(['original', 0, null]);
      expect(await code(print(s, 'cashier', { documentType: type, documentId: id, kind: 'reprint' }))).toBe('POS_APPROVAL_REQUIRED');
      const r1: any = await print(s, 'cashier', { documentType: type, documentId: id, kind: 'reprint' }, tok(s, 'manager'));
      expect([r1.data.kind, r1.data.reprintNumber, r1.data.approvedBy]).toEqual(['reprint', 1, s.managerId]);
      const r2: any = await print(s, 'manager', { documentType: type, documentId: id });
      expect([r2.data.kind, r2.data.reprintNumber]).toEqual(['reprint', 2]);
    }
    expect(await r.posAuditLogModel.countDocuments({ storeId: s.storeId, action: 'document_printed' })).toBe(2);
    expect(await r.posAuditLogModel.countDocuments({ storeId: s.storeId, action: 'document_reprinted' })).toBe(4);
    docs = await receipts.documentsOf(s.sellerId, d.sale);
    expect([docs.data.invoice.printed, docs.data.invoice.reprintCount, docs.data.creditNotes[0].printed, docs.data.creditNotes[0].reprintCount]).toEqual([true, 2, true, 2]);
  });

  it('the server decides: a client that asks for "original" after the original is out gets a reprint; a bad kind is refused', async () => {
    const f = await fresh(); const s = f.s; const d = await withSale(s);
    await print(s, 'manager', { documentType: 'invoice', documentId: d.sale });
    const again: any = await print(s, 'manager', { documentType: 'invoice', documentId: d.sale, kind: 'original' });
    expect([again.data.kind, again.data.requestedKind, again.data.reprintNumber]).toEqual(['reprint', 'original', 1]);
    expect(await code(print(s, 'manager', { documentType: 'invoice', documentId: d.sale, kind: 'copy' }))).toBe('PRINT_KIND_INVALID');
  });

  it('receipts keep G4.8: every recorded print of the receipt is a reprint, from #1', async () => {
    const f = await fresh(); const s = f.s; const d = await withSale(s);
    const a: any = await print(s, 'manager', { documentType: 'sale', documentId: d.sale });
    expect([a.data.kind, a.data.reprintNumber]).toEqual(['reprint', 1]);
  });

  it('no backfill: a document whose events predate G4.9 (no kind) continues as reprints from its highest number', async () => {
    const f = await fresh(); const s = f.s; const d = await withSale(s);
    await r.posReprintEventModel.collection.insertMany([1, 2].map((n) => ({ storeId: s.storeId, documentType: 'invoice', documentId: d.sale, saleId: d.sale, reprintNumber: n, createdAt: new Date() })));
    const next: any = await print(s, 'manager', { documentType: 'invoice', documentId: d.sale, kind: 'original' });
    expect([next.data.kind, next.data.reprintNumber]).toEqual(['reprint', 3]);
    expect(await r.posReprintEventModel.countDocuments({ documentId: d.sale, kind: { $exists: false } })).toBe(2); // untouched
  });

  it('two tills printing a new invoice at once: exactly one original, the other a reprint', async () => {
    const f = await fresh(); const s = f.s; const d = await withSale(s);
    const both: any[] = await Promise.all([1, 2].map(() => print(s, 'manager', { documentType: 'invoice', documentId: d.sale, kind: 'original' })));
    expect(both.map((x) => `${x.data.kind}#${x.data.reprintNumber}`).sort()).toEqual(['original#0', 'reprint#1']);
  });
});

describe('G4.9 · the offline-buildable receipt link (store public id + the sale\'s client key)', () => {
  it('the settings carry the store public id and the link base; the link resolves to "syncing" before the sale arrives and to the receipt after', async () => {
    const f = await fresh(); const s = f.s;
    const set: any = (await svc.getPosSettings(s.sellerId, s.storeId)).data;
    const slug = `store-${s.storeId}`;
    expect(set.storePublicId).toBe(slug);
    expect(set.receiptLinkBase).toMatch(new RegExp(`/r/s/${slug}/$`));
    const k = key();
    expect(await receipts.renderByClientKey(slug, k)).toBe('syncing');
    expect(SYNCING_PAGE).not.toMatch(/S-\d|Test Store/); // nothing about any sale or store
    const sale = await f.sell(2, { idempotencyKey: k, offline: true, clientCreatedAt: new Date(Date.now() - 600_000).toISOString() });
    const html = await receipts.renderByClientKey(slug, k);
    expect(html).toContain(sale.saleNumber);
    expect(html).toContain('Paid');
    // a manager revoking the token link stops this one too
    await receipts.getLink(s.sellerId, String(sale._id));
    await receipts.revoke(s.sellerId, String(sale._id), s.managerId);
    expect(await receipts.renderByClientKey(slug, k)).toBeNull();
  });

  it('no data for anything unknown: malformed key or slug, unknown store, another store\'s key, a stale or future key → null (the single 404)', async () => {
    const f = await fresh(); const s = f.s; const slug = `store-${s.storeId}`;
    const k = key();
    await f.sell(1, { idempotencyKey: k });
    const other = await fresh();
    expect(await receipts.renderByClientKey(slug, 'pos-123-abc')).toBeNull();
    expect(await receipts.renderByClientKey('Bad Slug!', k)).toBeNull();
    expect(await receipts.renderByClientKey('no-such-store', k)).toBeNull();
    expect(await receipts.renderByClientKey(`store-${other.s.storeId}`, k)).toBe('syncing'); // well-formed key, not this store's sale: nothing about it
    expect(await receipts.renderByClientKey(slug, key(Date.now() - CLIENT_LINK_WINDOW_MS - 86_400_000))).toBeNull();
    expect(await receipts.renderByClientKey(slug, key(Date.now() + 3 * 86_400_000))).toBeNull();
    const hk = key(Date.now() - 1000);
    const held = await f.sell(1, { status: 'held', idempotencyKey: hk });
    expect(held.status).toBe('held');
    expect(await receipts.renderByClientKey(slug, hk)).toBeNull();
  });
});
