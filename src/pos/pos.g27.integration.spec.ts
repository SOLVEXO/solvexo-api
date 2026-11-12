/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Types } from 'mongoose';
import { PosService } from './pos.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { MongoHarness, oidStr, seedStore, startMongoHarness } from './testing/mongo-harness';

/** G2.7 on a real replica-set MongoDB: the offline receipt's OFF- number as a LOOKUP reference, search by receipt number, a return at another till. */
jest.setTimeout(240_000);
let h: MongoHarness;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });

const makeService = () => new PosService({ repositories: h.repos } as any, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
async function fresh(opts: Parameters<typeof seedStore>[1] = {}) {
  const s = await seedStore(h, { stock: 50, ...opts });
  const svc = makeService();
  const sid = String(new Types.ObjectId());
  await h.repos.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sid), storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date(Date.now() - 7_200_000), openingCash: 50, totalSales: 0, totalTransactions: 0 });
  return { s, svc, sid };
}
type X = Awaited<ReturnType<typeof fresh>>;
const sale = async (x: X, over: any = {}) => ((await x.svc.createSale(x.s.sellerId, { storeId: x.s.storeId, sessionId: x.sid, registerId: x.s.registerId, employeeId: x.s.cashierId, items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 1 }], paymentMethod: 'cash', ...over } as any, tok(x.s, 'manager'))) as any).data;
const offline = (over: any = {}) => ({ offline: true, clientCreatedAt: new Date(Date.now() - 3_600_000).toISOString(), ...over });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };

describe('the offline receipt number is a LOOKUP reference (never the invoice number, never sequencing)', () => {
  it('stored on the sale (upper-cased) when an offline sale syncs; the invoice number is the next in sequence and does not depend on it', async () => {
    const x = await fresh();
    const a = await sale(x);
    const off = await sale(x, offline({ provisionalNumber: 'off-3fa9c1-0007' }));
    expect(off.provisionalNumber).toBe('OFF-3FA9C1-0007');
    expect(off.invoice.number).toBe('INV-000002');
    expect(off.invoice.offlineRef).toBe('OFF-3FA9C1-0007'); // shown on the invoice page
    expect(off.saleNumber).not.toContain('OFF');
    const b = await sale(x);
    expect([a.invoice.number, b.invoice.number]).toEqual(['INV-000001', 'INV-000003']); // sequencing never looks at it
  });

  it('unique per store: a second sale with the same number is STILL recorded (money was taken) without it and flagged; another store may use the same number', async () => {
    const x = await fresh(); const y = await fresh();
    const first = await sale(x, offline({ provisionalNumber: 'OFF-AAAAAA-0001' }));
    const second = await sale(x, offline({ provisionalNumber: 'OFF-AAAAAA-0001', idempotencyKey: 'k2' }));
    expect(first.provisionalNumber).toBe('OFF-AAAAAA-0001');
    expect(second.provisionalNumber ?? null).toBeNull();
    expect(second.needsReview).toBe(true);
    expect(second.flags.map((f: any) => f.type)).toContain('provisional_number_clash');
    expect(second.invoice.number).toBe('INV-000002');
    const other = await sale(y, offline({ provisionalNumber: 'OFF-AAAAAA-0001' }));
    expect(other.provisionalNumber).toBe('OFF-AAAAAA-0001');
  });

  it('a replay with the same idempotency key returns the same sale (the number is not "clashing with itself")', async () => {
    const x = await fresh();
    const a = await sale(x, offline({ provisionalNumber: 'OFF-BBBBBB-0002', idempotencyKey: 'same' }));
    const again = await sale(x, offline({ provisionalNumber: 'OFF-BBBBBB-0002', idempotencyKey: 'same' }));
    expect(String(again._id)).toBe(String(a._id));
    expect(await h.repos.saleModel.countDocuments({ storeId: x.s.storeId })).toBe(1);
  });

  it('an ONLINE sale ignores it; the field has a strict format', async () => {
    const x = await fresh();
    const a = await sale(x, { provisionalNumber: 'OFF-CCCCCC-0003' });
    expect(a.provisionalNumber ?? null).toBeNull();
    const bad = async (v: any) => (await validate(plainToInstance(CreateSaleDto, { storeId: 's', sessionId: 's', registerId: 'r', employeeId: 'e', items: [{ productId: 'p', variantId: 'v', qty: 1 }], paymentMethod: 'cash', provisionalNumber: v }))).map((e) => e.property);
    expect(await bad('OFF-3FA9C1-0007')).toEqual([]);
    for (const v of ['INV-000001', 'off-xx', 'OFF--1', 'OFF-ABC-', 'x'.repeat(60), 'OFF-ABC-1; drop']) expect(await bad(v)).toContain('provisionalNumber');
  });
});

describe('finding a sale by what the customer\'s receipt shows', () => {
  it('OFF- number (any case), tax invoice number, receipt number, a bare number, a credit note number — and nothing else', async () => {
    const x = await fresh();
    const a = await sale(x, offline({ provisionalNumber: 'OFF-3FA9C1-0007' }));
    const b = await sale(x);
    const ids = async (ref: string) => ((await x.svc.lookupSales(x.s.sellerId, x.s.storeId, ref)) as any).data.map((s: any) => String(s._id));
    expect(await ids('off-3fa9c1-0007')).toEqual([String(a._id)]);
    expect(await ids('OFF-3FA9C1-0007')).toEqual([String(a._id)]);
    expect(await ids('INV-000002')).toEqual([String(b._id)]);
    expect(await ids(b.saleNumber)).toEqual([String(b._id)]);
    expect(await ids('2')).toEqual([String(b._id)]); // bare number → INV-000002 / POS-00002
    await x.svc.refundSale(x.s.sellerId, String(a._id), {}, tok(x.s, 'manager'));
    expect(await ids('CN-000001')).toEqual([String(a._id)]);
    for (const nope of ['', 'x', 'OFF-NOPE-0001', 'INV-999999', "'; db.dropDatabase()", 'OFF-3FA9C1']) expect(await ids(nope)).toEqual([]);
  });

  it('is scoped to the store and to its seller; the Orders list takes the same `search`', async () => {
    const x = await fresh(); const y = await fresh();
    const a = await sale(x, offline({ provisionalNumber: 'OFF-3FA9C1-0007' }));
    expect(((await y.svc.lookupSales(y.s.sellerId, y.s.storeId, 'OFF-3FA9C1-0007')) as any).data).toEqual([]);
    await expect(y.svc.lookupSales(y.s.sellerId, x.s.storeId, 'OFF-3FA9C1-0007')).rejects.toBeDefined();
    const list: any = (await x.svc.getSales(x.s.sellerId, { storeId: x.s.storeId, search: 'off-3fa9c1-0007' })).data;
    expect(list.sales.map((s: any) => String(s._id))).toEqual([String(a._id)]);
    const none: any = (await x.svc.getSales(x.s.sellerId, { storeId: x.s.storeId, search: 'INV-424242' })).data;
    expect(none.sales).toEqual([]);
  });
});

describe('a return at ANOTHER till using the offline receipt', () => {
  it('found by the OFF- number, returned from a second register: its own open shift pays the cash; without one, refused; the credit note links the invoice', async () => {
    const x = await fresh();
    const off = await sale(x, offline({ provisionalNumber: 'OFF-3FA9C1-0007' }));
    // the second till: another register with its own open shift
    const reg2 = oidStr(); const sid2 = String(new Types.ObjectId());
    await h.repos.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sid2), storeId: x.s.storeId, registerId: reg2, employeeId: x.s.managerId, status: 'open', openedAt: new Date(), openingCash: 20, totalSales: 0, totalTransactions: 0 });
    // the original till's shift is closed (that till is not even there)
    await h.repos.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(x.sid) }, { $set: { status: 'closed', closedAt: new Date() } });
    const found: any = (await x.svc.lookupSales(x.s.sellerId, x.s.storeId, 'off-3fa9c1-0007')).data[0];
    expect(found.invoice.number).toBe('INV-000001');
    // not naming the second till: the sale's own (closed) register has no open shift → a cash refund is refused
    expect(await code(x.svc.refundSale(x.s.sellerId, String(found._id), {}, tok(x.s, 'manager')))).toBe('OPEN_SHIFT_REQUIRED');
    // naming the till that is actually paying: its open shift pays the cash
    const r: any = await x.svc.refundSale(x.s.sellerId, String(found._id), { registerId: reg2 } as any, tok(x.s, 'manager'));
    expect(r.data.creditNote.number).toBe('CN-000001');
    const note: any = await h.repos.posCreditNoteModel.findOne({ storeId: x.s.storeId }).lean();
    expect([note.invoiceNumber, note.saleId, note.registerId]).toEqual(['INV-000001', String(off._id), reg2]);
    const refund: any = await h.repos.posRefundModel.findOne({ saleId: String(off._id) }).lean();
    expect([refund.registerId, refund.sessionId]).toEqual([reg2, sid2]);
    // an unknown register id has no shift either
    const again = await sale(x, offline({ provisionalNumber: 'OFF-3FA9C1-0008' }));
    expect(await code(x.svc.refundSale(x.s.sellerId, String(again._id), { registerId: oidStr() } as any, tok(x.s, 'manager')))).toBe('OPEN_SHIFT_REQUIRED');
  });
});
