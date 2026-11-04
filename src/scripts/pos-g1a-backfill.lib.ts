/* eslint-disable prettier/prettier */
import type { Db } from 'mongodb';

/**
 * G1a backfill: gives every EXISTING sale payment and refund its own record (pos_payments / pos_refunds) and copies
 * the shift onto old sales. Pure functions over a Db handle so the migration script and the tests run the same code.
 *
 *  - up(db, {dryRun})   inserts the missing records. Idempotent: the unique indexes (saleId+lineNo, saleId+seq) make a
 *                       second run a no-op. dryRun = true counts what WOULD be written and writes nothing.
 *  - down(db, {dryRun}) removes ONLY what `up` created (records flagged `backfilled: true`, and the `shiftId` /
 *                       `refunds.$.refundId` markers it set). Live records written by the running API are untouched.
 *
 * Money is copied as stored (major units + the sale's currency snapshot) — no rounding, no conversion (minor units are G1b).
 */
export interface BackfillCounts {
  salesScanned: number;
  paymentsExpected: number;
  paymentsBefore: number;
  paymentsToInsert: number;
  refundsExpected: number;
  refundsBefore: number;
  refundsToInsert: number;
  salesMissingShift: number;
  shiftIdsToSet: number;
}

const PAYMENTS = 'pos_payments';
const REFUNDS = 'pos_refunds';
/** Mongoose pluralises `PosPayment` → `posPayments`; resolve the real names once so the migration works on either. */
export const COLLECTIONS = { payments: 'pospayments', refunds: 'posrefunds', sales: 'sales', sessions: 'registersessions' };

const statusFor = (tender: string) => (tender === 'cash' ? 'confirmed' : 'recorded_unverified');

/** Same rule as pos-money.util `effectivePayments`: a legacy sale without `payments[]` is one tender for the whole total. */
function paymentsOf(sale: any): Array<{ method: string; amount: number; tendered?: number | null; reference?: string | null }> {
  if (Array.isArray(sale.payments) && sale.payments.length > 0) return sale.payments;
  if (!sale.paymentMethod) return [];
  return [{ method: sale.paymentMethod, amount: sale.total ?? 0, reference: null }];
}

const isFinal = (s: any) => ['completed', 'refunded', 'partially_refunded', 'voided'].includes(s.status);

export async function backfillUp(db: Db, opts: { dryRun: boolean; batch?: number }): Promise<BackfillCounts> {
  const sales = db.collection(COLLECTIONS.sales);
  const pays = db.collection(COLLECTIONS.payments);
  const refs = db.collection(COLLECTIONS.refunds);
  const sessions = db.collection(COLLECTIONS.sessions);

  const counts: BackfillCounts = {
    salesScanned: 0, paymentsExpected: 0, paymentsBefore: await pays.countDocuments({}), paymentsToInsert: 0,
    refundsExpected: 0, refundsBefore: await refs.countDocuments({}), refundsToInsert: 0, salesMissingShift: 0, shiftIdsToSet: 0,
  };

  const sessionShift = new Map<string, string | null>();
  const shiftOf = async (sessionId: string): Promise<string | null> => {
    if (sessionShift.has(sessionId)) return sessionShift.get(sessionId)!;
    let v: string | null = null;
    try {
      const { ObjectId } = await import('mongodb');
      const s: any = await sessions.findOne({ _id: new ObjectId(sessionId) }, { projection: { shiftId: 1 } });
      v = s?.shiftId ? String(s.shiftId) : null;
    } catch { v = null; }
    sessionShift.set(sessionId, v);
    return v;
  };

  const cursor = sales.find({ status: { $ne: 'held' } });
  for await (const sale of cursor) {
    if (!isFinal(sale)) continue;
    counts.salesScanned++;
    const saleId = String(sale._id);
    const ctx = {
      storeId: sale.storeId, registerId: sale.registerId ?? null, sessionId: sale.sessionId ?? null,
      shiftId: sale.shiftId ?? null, deviceId: sale.deviceId ?? null, employeeId: sale.employeeId ?? null,
    };
    if (!ctx.shiftId && sale.sessionId) {
      counts.salesMissingShift++;
      const sh = await shiftOf(String(sale.sessionId));
      if (sh) {
        counts.shiftIdsToSet++;
        ctx.shiftId = sh;
        if (!opts.dryRun) await sales.updateOne({ _id: sale._id, $or: [{ shiftId: null }, { shiftId: { $exists: false } }] }, { $set: { shiftId: sh, shiftIdBackfilled: true } });
      }
    }

    const lines = paymentsOf(sale);
    for (let i = 0; i < lines.length; i++) {
      counts.paymentsExpected++;
      const l: any = lines[i];
      const exists = await pays.findOne({ saleId, lineNo: i }, { projection: { _id: 1 } });
      if (exists) continue;
      counts.paymentsToInsert++;
      if (opts.dryRun) continue;
      try {
        await pays.insertOne({
          saleId, saleNumber: sale.saleNumber ?? null, lineNo: i, tender: l.method, amount: l.amount,
          tendered: l.tendered ?? null, currency: sale.currency ?? null, currencyExponent: sale.currencyExponent ?? null,
          reference: l.reference ?? null, status: statusFor(l.method), confirmationSource: null, confirmedAt: null,
          ...ctx, ...(sale.idempotencyKey ? { idempotencyKey: sale.idempotencyKey } : {}),
          createdAt: sale.createdAt ?? new Date(), backfilled: true,
        });
      } catch (e: any) { if (e?.code !== 11000) throw e; }
    }

    const refunds: any[] = Array.isArray(sale.refunds) ? sale.refunds : [];
    for (let seq = 0; seq < refunds.length; seq++) {
      counts.refundsExpected++;
      const r = refunds[seq];
      const exists = await refs.findOne({ saleId, seq }, { projection: { _id: 1 } });
      if (exists) continue;
      counts.refundsToInsert++;
      if (opts.dryRun) continue;
      const tenders = r.tenders ?? [];
      let refundId: any;
      try {
        const res = await refs.insertOne({
          saleId, saleNumber: sale.saleNumber ?? null, seq, reference: `${sale.saleNumber ?? saleId}-R${seq + 1}`,
          kind: r.kind, amount: r.amount, currency: r.currency ?? sale.currency ?? null, currencyExponent: r.currencyExponent ?? sale.currencyExponent ?? null,
          tenders, items: r.items ?? [], reason: null,
          status: tenders.every((t: any) => t.method === 'cash') ? 'confirmed' : 'recorded_unverified', confirmationSource: null,
          storeId: sale.storeId, registerId: sale.registerId ?? null, sessionId: sale.sessionId ?? null, shiftId: ctx.shiftId,
          deviceId: null, employeeId: r.employeeId ?? null, saleSessionId: sale.sessionId ?? null, saleEmployeeId: sale.employeeId ?? null,
          createdAt: r.createdAt ?? new Date(), backfilled: true,
        });
        refundId = res.insertedId;
      } catch (e: any) { if (e?.code === 11000) continue; throw e; }
      await sales.updateOne({ _id: sale._id }, { $set: { [`refunds.${seq}.refundId`]: String(refundId) } });
    }
  }
  return counts;
}

export interface RollbackCounts { paymentsRemoved: number; refundsRemoved: number; shiftIdsUnset: number; refundIdsUnset: number }

export async function backfillDown(db: Db, opts: { dryRun: boolean }): Promise<RollbackCounts> {
  const sales = db.collection(COLLECTIONS.sales);
  const pays = db.collection(COLLECTIONS.payments);
  const refs = db.collection(COLLECTIONS.refunds);
  const out: RollbackCounts = { paymentsRemoved: 0, refundsRemoved: 0, shiftIdsUnset: 0, refundIdsUnset: 0 };

  out.paymentsRemoved = await pays.countDocuments({ backfilled: true });
  out.refundsRemoved = await refs.countDocuments({ backfilled: true });
  out.shiftIdsUnset = await sales.countDocuments({ shiftIdBackfilled: true });
  const backfilledRefunds = await refs.find({ backfilled: true }, { projection: { _id: 1, saleId: 1, seq: 1 } }).toArray();
  out.refundIdsUnset = backfilledRefunds.length;
  if (opts.dryRun) return out;

  const { ObjectId } = await import('mongodb');
  for (const r of backfilledRefunds) {
    await sales.updateOne({ _id: new ObjectId(String(r.saleId)) }, { $unset: { [`refunds.${r.seq}.refundId`]: '' } });
  }
  await pays.deleteMany({ backfilled: true });
  await refs.deleteMany({ backfilled: true });
  await sales.updateMany({ shiftIdBackfilled: true }, { $unset: { shiftId: '', shiftIdBackfilled: '' } });
  return out;
}

export { PAYMENTS as PAYMENTS_NAME, REFUNDS as REFUNDS_NAME };
