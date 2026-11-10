/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import { Types } from 'mongoose';
import { randomBytes } from 'crypto';
import * as schema from '@/database/schema';
import { JobLeaseService } from '../common/job-lease/job-lease.service';
import { JobLeaseSchema } from '../common/job-lease/job-lease.schema';
import { PosAuditSealService, canonical } from './pos-audit-seal.service';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';

/** G4.3: nightly audit seals — one hash per store per store-day, chained, append-only; verify detects any change. */
jest.setTimeout(300_000);
let h: MongoHarness; let seals: PosAuditSealService; let r: any; let leases: JobLeaseService;
beforeAll(async () => {
  h = await startMongoHarness();
  Object.assign(h.repos, {
    posAuditSealModel: h.conn.model(schema.PosAuditSeal.name, schema.PosAuditSealSchema),
    supplierLedgerEntryModel: h.conn.model(schema.SupplierLedgerEntry.name, schema.SupplierLedgerEntrySchema), purchaseReceiptModel: h.conn.model(schema.PurchaseReceipt.name, schema.PurchaseReceiptSchema),
    posExpenseModel: h.conn.model(schema.PosExpense.name, schema.PosExpenseSchema), posExpenseEventModel: h.conn.model(schema.PosExpenseEvent.name, schema.PosExpenseEventSchema),
    posAttendanceEventModel: h.conn.model(schema.PosAttendanceEvent.name, schema.PosAttendanceEventSchema),
  });
  r = h.repos;
  await r.posAuditSealModel.init();
  leases = new JobLeaseService(h.conn.model('JobLease', JobLeaseSchema) as any);
  seals = new PosAuditSealService({ repositories: r } as any, leases);
});
afterAll(async () => { await h?.stop(); });

const at = (iso: string) => new Date(iso);
/** an ObjectId whose time part is `when` (and the rest random, like a real one minted then) */
const idAt = (when: Date) => new Types.ObjectId(Math.floor(when.getTime() / 1000).toString(16).padStart(8, '0') + randomBytes(8).toString('hex'));
/** an audit row WRITTEN at `when` (its ObjectId carries that time, like a real insert then) */
const row = (storeId: string, when: Date, action = 'sale_completed', extra: any = {}) => r.posAuditLogModel.collection.insertOne({ _id: idAt(when), storeId, employeeId: 'e1', action, targetId: 't', targetType: 'sale', metadata: { n: 1 }, createdAt: when, ...extra });
const movement = (storeId: string, when: Date, qty: number) => r.stockMovementModel.collection.insertOne({ _id: idAt(when), storeId, variantId: 'v1', type: 'sale', qtyDelta: qty, createdAt: when });

async function store(tz = 'Asia/Karachi') {
  const s = await seedStore(h);
  await r.storeModel.collection.updateOne({ _id: new Types.ObjectId(s.storeId) }, { $set: { timezone: tz } });
  return s;
}

describe('sealing', () => {
  it('seals every finished store-day once (in the store zone), chained, and not today; a second run seals nothing new', async () => {
    const s = await store();
    await row(s.storeId, at('2026-11-01T10:00:00+05:00')); await movement(s.storeId, at('2026-11-01T11:00:00+05:00'), -2);
    await row(s.storeId, at('2026-11-02T23:30:00+05:00')); // 18:30 UTC — still the 2nd in Karachi
    await row(s.storeId, at('2026-11-03T00:30:00+05:00')); // 19:30 UTC on the 2nd — the 3rd in Karachi
    const now = at('2026-11-03T12:00:00+05:00');
    const days = await seals.sealStore(s.storeId, now);
    expect(days).toEqual(['2026-11-01', '2026-11-02']); // the 3rd is not over
    const list: any[] = await r.posAuditSealModel.find({ storeId: s.storeId }).sort({ day: 1 }).lean();
    expect(list.map((x) => [x.day, x.count])).toEqual([['2026-11-01', 2], ['2026-11-02', 1]]);
    expect(list[0].parts.audit_log.count).toBe(1); expect(list[0].parts.stock_movements.count).toBe(1);
    expect(list[1].prevHash).toBe(list[0].hash);
    expect(await seals.sealStore(s.storeId, now)).toEqual([]);
    // a day with nothing still gets a seal, so the chain has no holes
    expect(await seals.sealStore(s.storeId, at('2026-11-05T12:00:00+05:00'))).toEqual(['2026-11-03', '2026-11-04']);
    expect((await r.posAuditSealModel.findOne({ storeId: s.storeId, day: '2026-11-04' }).lean()).count).toBe(0);
    // the seals themselves are append-only
    await expect(r.posAuditSealModel.updateOne({ storeId: s.storeId }, { $set: { hash: 'x' } })).rejects.toThrow(/append-only/);
  });

  it('two instances sealing at once: the lease lets one through; the unique day keeps it exactly-once anyway', async () => {
    const s = await store();
    await row(s.storeId, at('2026-10-20T10:00:00+05:00'));
    const now = at('2026-10-23T10:00:00+05:00');
    const [a, b] = await Promise.all([leases.withLease('pos:audit-seal', 60_000, () => seals.sealAll(now)), leases.withLease('pos:audit-seal', 60_000, () => seals.sealAll(now))]);
    expect([a, b].filter((x) => typeof x === 'symbol')).toHaveLength(1);
    await Promise.all([seals.sealStore(s.storeId, now), seals.sealStore(s.storeId, now)]);
    const daysSealed: any[] = await r.posAuditSealModel.find({ storeId: s.storeId }).lean();
    expect(new Set(daysSealed.map((x) => x.day)).size).toBe(daysSealed.length);
  });

  it('a DST zone: the autumn day has 25 hours and its records are all in it', async () => {
    const s = await store('Europe/London');
    await row(s.storeId, at('2026-10-25T00:30:00Z')); // 01:30 BST
    await row(s.storeId, at('2026-10-25T23:30:00Z')); // 23:30 GMT, same local day
    await seals.sealStore(s.storeId, at('2026-10-27T12:00:00Z'));
    const d: any = await r.posAuditSealModel.findOne({ storeId: s.storeId, day: '2026-10-25' }).lean();
    expect([(d.to - d.from) / 3_600_000, d.count]).toEqual([25, 2]);
  });
});

describe('verify detects any change', () => {
  async function sealed() {
    const s = await store();
    await row(s.storeId, at('2026-09-01T10:00:00+05:00')); await row(s.storeId, at('2026-09-01T12:00:00+05:00'), 'refund'); await movement(s.storeId, at('2026-09-02T09:00:00+05:00'), -1);
    await seals.sealStore(s.storeId, at('2026-09-04T12:00:00+05:00'));
    return s;
  }
  it('untouched → ok', async () => {
    const s = await sealed();
    const v = await seals.verify(s.storeId);
    expect([v.ok, v.days, v.results.every((x: any) => x.status === 'ok')]).toEqual([true, 3, true]);
  });
  it('an edited record (raw database write, bypassing the app) → changed, naming the collection', async () => {
    const s = await sealed();
    await r.posAuditLogModel.collection.updateOne({ storeId: s.storeId, action: 'refund' }, { $set: { metadata: { n: 2 } } });
    const v = await seals.verify(s.storeId);
    expect(v.ok).toBe(false);
    expect(v.results.find((x: any) => x.day === '2026-09-01')).toMatchObject({ status: 'changed', changedParts: [{ part: 'audit_log', sealedCount: 2, nowCount: 2 }] });
    expect(v.results.find((x: any) => x.day === '2026-09-02').status).toBe('ok');
  });
  it('a deleted record and a back-dated insertion → changed, with the counts then and now', async () => {
    const s = await sealed();
    await r.stockMovementModel.collection.deleteOne({ storeId: s.storeId });
    await row(s.storeId, at('2026-09-01T15:00:00+05:00'), 'smuggled'); // an id forged to look written that day
    const v = await seals.verify(s.storeId);
    expect(v.results.find((x: any) => x.day === '2026-09-02').changedParts).toEqual([{ part: 'stock_movements', sealedCount: 1, nowCount: 0 }]);
    expect(v.results.find((x: any) => x.day === '2026-09-01').changedParts).toEqual([{ part: 'audit_log', sealedCount: 2, nowCount: 3 }]);
  });
  it('a record written TODAY with an old business date (late offline sync / backfill) does not disturb a sealed day', async () => {
    const s = await sealed();
    await r.posAuditLogModel.collection.insertOne({ storeId: s.storeId, action: 'offline_sale_synced', createdAt: at('2026-09-01T10:00:00+05:00') }); // new ObjectId = now
    expect((await seals.verify(s.storeId)).ok).toBe(true);
  });
  it('a tampered seal chain → broken_chain', async () => {
    const s = await sealed();
    await r.posAuditSealModel.collection.updateOne({ storeId: s.storeId, day: '2026-09-02' }, { $set: { prevHash: 'f'.repeat(64) } });
    const v = await seals.verify(s.storeId);
    expect(v.results.find((x: any) => x.day === '2026-09-02').status).toBe('broken_chain');
  });
  it('canonical form is stable (key order, dates, ids)', () => {
    const id = new Types.ObjectId();
    expect(canonical({ b: 1, a: [new Date('2026-01-01T00:00:00Z'), id], __v: 3 })).toBe(`{"a":["2026-01-01T00:00:00.000Z","${String(id)}"],"b":1}`);
  });
});
