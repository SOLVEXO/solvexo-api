/* eslint-disable prettier/prettier */
import { Long, ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { isoExponent } from '../common/money-minor.util';
export { assertSafeTarget } from './pos-g1b-minor-backfill.lib';

/**
 * Store-credit migration (G3.3, option B): the legacy float ledger (`storecredittransactions`) → the minor-unit ledger (`store_credit_entries` + `store_credit_lots`).
 * EVERY legacy row becomes an entry (history is kept), and every spendable credit lot (remaining > 0, not expired) becomes a new lot with its own expiry — so a customer's balance
 * and what expires when are exactly what they were. Amounts are converted with the currency's ISO exponent; a value off the currency grid is ROUNDED DOWN (never up: the store
 * never owes more than the old ledger said) and listed.
 *
 *  - ORDER OF OPERATIONS (production): set STORE_CREDIT_LEDGER=migrating (credit reads 0, nothing can be spent or changed in either ledger) → `up` → check → STORE_CREDIT_LEDGER=new.
 *    While the mode is `legacy` the new collections are a shadow nobody reads, so a dry run / rehearsal can never cause a double spend.
 *  - IDEMPOTENT (`legacyId` is unique in both new collections; only unmigrated rows are touched), RESUMABLE (re-run = continue), REVERSIBLE (`down` deletes exactly the rows carrying
 *    `legacyId` and removes the marker from the legacy rows; it REFUSES when the new ledger has activity of its own — a spend after the switch — unless `--force-lose-activity`),
 *    refuses non-dev databases unless BOTH `--production` and `--i-have-a-backup`, does not read `.env`.
 *  - SELF-CHECK: after `up`, Σ remaining per (store, customer, currency) in the new ledger must equal Σ floor(old remaining); a mismatch is reported and the run exits non-zero.
 */
export const SCM = { legacy: 'storecredittransactions', entries: 'storecreditentries', lots: 'storecreditlots' } as const;
export const MARK = 'migratedToLedgerAt';
export interface MigrateOptions { dryRun: boolean; now?: () => Date; maxRows?: number }
export interface MigrateReport {
  dryRun: boolean; legacyRows: number; alreadyMigrated: number; toMigrate: number; entriesWritten: number; lotsWritten: number;
  offGrid: Array<{ id: string; field: string; value: number; roundedDownMinor: number }>; expiredNotMigrated: number; futureExpiryLots: number;
  balancesByCurrency: Record<string, { customers: number; totalMinor: number }>; mismatches: Array<{ storeId: string; customerId: string; currency: string; legacyMinor: number; newMinor: number }>;
}
const L = (n: number) => Long.fromNumber(n);
const NOISE = 1e-6;
const floorMinor = (v: number, exp: number) => Math.floor(Math.abs(v) * 10 ** exp + NOISE);

export async function migrateStoreCredit(db: Db, opts: MigrateOptions): Promise<MigrateReport> {
  const now = (opts.now ?? (() => new Date()))();
  const legacy = db.collection(SCM.legacy);
  const rep: MigrateReport = { dryRun: opts.dryRun, legacyRows: await legacy.countDocuments({}), alreadyMigrated: await legacy.countDocuments({ [MARK]: { $exists: true } }), toMigrate: 0, entriesWritten: 0, lotsWritten: 0, offGrid: [], expiredNotMigrated: 0, futureExpiryLots: 0, balancesByCurrency: {}, mismatches: [] };
  const rows = await legacy.find({ [MARK]: { $exists: false } }).sort({ createdAt: 1, _id: 1 }).toArray();
  rep.toMigrate = rows.length;
  const newLotOf = new Map<string, ObjectId>(); // legacy lot id → new lot id
  for await (const l of db.collection(SCM.lots).find({ legacyId: { $type: 'string' } }, { projection: { legacyId: 1 } })) newLotOf.set(String((l as any).legacyId), l._id as ObjectId);
  const customers = new Map<string, Set<string>>();
  let budget = opts.maxRows ?? Infinity;

  for (const row of rows as any[]) {
    if (budget <= 0) break;
    const exp = isoExponent(row.currency);
    const id = String(row._id);
    const track = (field: string, v: any) => { if (typeof v === 'number' && Math.abs(Math.abs(v) * 10 ** exp - Math.round(Math.abs(v) * 10 ** exp)) > NOISE && rep.offGrid.length < 50) rep.offGrid.push({ id, field, value: v, roundedDownMinor: floorMinor(v, exp) }); };
    track('amount', row.amount); track('remaining', row.remaining); track('balanceAfter', row.balanceAfter);
    const isCreditRow = ['issue', 'adjust_credit', 'restore', 'refund_credit'].includes(row.type);
    const spendable = isCreditRow && Number(row.remaining) > 0 && !row.expiredHandled && (!row.expiresAt || new Date(row.expiresAt) > now);
    if (isCreditRow && Number(row.remaining) > 0 && !spendable) rep.expiredNotMigrated++;
    let lotId: ObjectId | null = null;
    if (spendable) {
      lotId = new ObjectId();
      newLotOf.set(id, lotId);
      if (row.expiresAt) rep.futureExpiryLots++;
      const cur = rep.balancesByCurrency[row.currency] ?? (rep.balancesByCurrency[row.currency] = { customers: 0, totalMinor: 0 });
      cur.totalMinor += floorMinor(row.remaining, exp);
      const key = `${row.storeId}|${row.currency}`;
      const set = customers.get(key) ?? customers.set(key, new Set()).get(key)!;
      if (!set.has(row.customerId)) { set.add(row.customerId); cur.customers++; }
    }
    const sign = Number(row.amount) < 0 ? -1 : 1;
    const entry: any = {
      _id: new ObjectId(), storeId: row.storeId, customerId: row.customerId, currency: row.currency, currencyExponent: exp, type: row.type,
      amountMinor: L(sign * floorMinor(row.amount, exp)), balanceAfterMinor: L(Math.max(0, floorMinor(row.balanceAfter ?? 0, exp))),
      lotId: lotId ? String(lotId) : (isCreditRow ? id : null), expiresAt: row.expiresAt ?? null,
      consumed: (row.consumed ?? []).map((c: any) => ({ lotId: String(newLotOf.get(String(c.lotId)) ?? c.lotId), amountMinor: floorMinor(c.amount, exp) })),
      orderId: row.orderId ?? null, checkoutId: row.checkoutId ?? null, saleId: null, refundId: null, creditNoteNumber: null, idemKey: row.idemKey ?? null, note: row.note ?? '',
      actorId: row.actorId ?? null, actorRole: row.actorRole ?? null, approvedBy: null, deviceId: null, registerId: null, sessionId: null, legacyId: id, createdAt: row.createdAt, __v: 0,
    };
    if (!opts.dryRun) {
      if (lotId) {
        await db.collection(SCM.lots).insertOne({ _id: lotId, storeId: row.storeId, customerId: row.customerId, currency: row.currency, currencyExponent: exp, amountMinor: L(floorMinor(row.amount, exp)), remainingMinor: L(floorMinor(row.remaining, exp)), expiresAt: row.expiresAt ?? null, expiredHandled: false, entryId: String(entry._id), source: row.type, legacyId: id, createdAt: row.createdAt, updatedAt: row.createdAt, __v: 0 } as any);
        rep.lotsWritten++;
      }
      await db.collection(SCM.entries).insertOne(entry);
      await legacy.updateOne({ _id: row._id }, { $set: { [MARK]: now } });
    } else if (lotId) rep.lotsWritten++;
    rep.entriesWritten++;
    budget--;
  }

  // self-check: the new spendable balance of every (store, customer, currency) = the old one, floored per lot
  if (!opts.dryRun) {
    const lotsAgg = await db.collection(SCM.lots).aggregate([{ $match: { legacyId: { $type: 'string' }, remainingMinor: { $gt: 0 } } }, { $group: { _id: { s: '$storeId', c: '$customerId', cur: '$currency' }, total: { $sum: '$remainingMinor' } } }]).toArray();
    const oldAgg = new Map<string, number>();
    for (const r of await legacy.find({ [MARK]: { $exists: true }, remaining: { $gt: 0 }, expiredHandled: { $ne: true }, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }).toArray() as any[]) {
      if (!['issue', 'adjust_credit', 'restore', 'refund_credit'].includes(r.type)) continue;
      const k = `${r.storeId}|${r.customerId}|${r.currency}`;
      oldAgg.set(k, (oldAgg.get(k) ?? 0) + floorMinor(r.remaining, isoExponent(r.currency)));
    }
    const seen = new Set<string>();
    for (const a of lotsAgg as any[]) {
      const k = `${a._id.s}|${a._id.c}|${a._id.cur}`; seen.add(k);
      const n = typeof a.total === 'object' ? a.total.toNumber() : Number(a.total);
      if ((oldAgg.get(k) ?? 0) !== n) rep.mismatches.push({ storeId: a._id.s, customerId: a._id.c, currency: a._id.cur, legacyMinor: oldAgg.get(k) ?? 0, newMinor: n });
    }
    for (const [k, v] of oldAgg) if (!seen.has(k) && v > 0) { const [s, c, cur] = k.split('|'); rep.mismatches.push({ storeId: s, customerId: c, currency: cur, legacyMinor: v, newMinor: 0 }); }
  }
  return rep;
}

/** Removes exactly what `up` wrote. Refuses if the new ledger has rows of its own (activity after the switch) unless [force]. */
export async function migrateStoreCreditDown(db: Db, opts: { dryRun: boolean; force?: boolean }): Promise<{ entries: number; lots: number; unmarked: number; ownActivity: number }> {
  const ownActivity = await db.collection(SCM.entries).countDocuments({ legacyId: null }) + await db.collection(SCM.lots).countDocuments({ legacyId: null });
  const out = { entries: await db.collection(SCM.entries).countDocuments({ legacyId: { $type: 'string' } }), lots: await db.collection(SCM.lots).countDocuments({ legacyId: { $type: 'string' } }), unmarked: await db.collection(SCM.legacy).countDocuments({ [MARK]: { $exists: true } }), ownActivity };
  if (opts.dryRun) return out;
  if (ownActivity > 0 && !opts.force) throw new Error(`Refusing to remove the migration: the new ledger has ${ownActivity} row(s) of its own (credit spent / issued after the switch) that would be LOST. Switch STORE_CREDIT_LEDGER back only if that is acceptable and pass --force-lose-activity.`);
  await db.collection(SCM.entries).deleteMany({ legacyId: { $type: 'string' } });
  await db.collection(SCM.lots).deleteMany({ legacyId: { $type: 'string' } });
  await db.collection(SCM.legacy).updateMany({ [MARK]: { $exists: true } }, { $unset: { [MARK]: '' } });
  return out;
}
