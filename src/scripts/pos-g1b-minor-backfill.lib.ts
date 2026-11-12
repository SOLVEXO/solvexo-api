/* eslint-disable prettier/prettier */
import { Long } from 'mongodb';
import type { Db } from 'mongodb';
import { isoExponent, toMinor } from '../common/money-minor.util';

/**
 * G1b step c: fills the `...Minor` twins (and the currency/exponent snapshot) on rows written before the dual-write.
 *
 *  - IDEMPOTENT: only rows still missing a minor twin are touched, and only the missing twins are set; a live dual-written value is never overwritten.
 *  - SAFE UNDER LIVE TRAFFIC: every write is guarded by the values it was computed from (optimistic) and a lost race is retried from a fresh read.
 *    Shift counters (the only hot fields) are filled by an aggregation-pipeline update with `$ifNull`, so a concurrent sale's `$add` and the backfill
 *    cannot lose each other's write.
 *  - RESUMABLE: a checkpoint per collection (last `_id`); `maxDocs` lets a test (or an operator) stop part-way and continue.
 *  - REVERSIBLE: `backfillDown` removes only what this backfill added (rows carrying `minorBackfilledAt`).
 *  - EXPONENT: the row's own snapshot, else the store's baseCurrency through the ISO table (`currencyInferred: true`, snapshot written). Never the storefront display decimals.
 */
export const G1B = {
  sales: 'sales', sessions: 'registersessions', payments: 'pospayments', refunds: 'posrefunds', stores: 'stores', checkpoints: 'g1b_backfill_checkpoints',
} as const;

export interface BackfillOptions {
  dryRun: boolean;
  batchSize?: number;
  /** stop after this many documents in total (simulates a crash / lets an operator run in slices) */
  maxDocs?: number;
  /** continue from the stored checkpoints instead of the start (a re-run from the start is also safe: idempotent) */
  resume?: boolean;
  /** test hook: runs after a document was read and before it is written (inject a concurrent change) */
  beforeWrite?: (collection: string, doc: any) => Promise<void> | void;
  now?: () => Date;
}

export interface CollectionReport {
  collection: string;
  totalDocs: number;
  candidates: number; // docs still missing minor twins (what a real run would touch)
  written: number;
  conflictsRetried: number;
  skippedNoExponent: number;
  currencyInferred: number;
  floatNoise: number; // values off the grid by float noise only (< 1e-6 minor units): converted silently
  offGrid: Array<{ id: string; field: string; value: number; roundedMinor: number }>; // a genuinely off-grid value (rounded; listed for review)
  readComputeDocsPerSec?: number;
}
export interface BackfillReport {
  dryRun: boolean; batchSize: number; collections: CollectionReport[];
  totalCandidates: number; assumedWriteDocsPerSec: number; estimatedSeconds: number;
}

const CONCURRENCY = 25;
const f = (exp: number) => 10 ** exp;
const NOISE = 1e-6;

/** Refuses anything that does not look like a throw-away database unless BOTH explicit production flags are given. */
export function assertSafeTarget(dbName: string, flags: { production?: boolean; iHaveABackup?: boolean }): void {
  if (/dev|test/i.test(dbName)) return;
  if (flags.production && flags.iHaveABackup) return;
  throw new Error(`Refusing to touch database "${dbName}": it does not look like a dev/test database. For a real run pass BOTH --production and --i-have-a-backup (after a mongodump and a dry run).`);
}

class Ctx {
  baseCurrency = new Map<string, string>();
  constructor(readonly db: Db) {}
  async load() {
    for await (const s of this.db.collection(G1B.stores).find({}, { projection: { baseCurrency: 1 } })) this.baseCurrency.set(String(s._id), String((s as any).baseCurrency ?? 'USD'));
  }
  /** exponent + whether it had to be inferred */
  expFor(doc: any, storeId: string | undefined): { exp: number; currency: string; inferred: boolean } {
    if (doc.currencyExponent !== undefined && doc.currencyExponent !== null) return { exp: doc.currencyExponent, currency: doc.currency ?? this.baseCurrency.get(String(storeId ?? doc.storeId)) ?? 'USD', inferred: false };
    const cur = this.baseCurrency.get(String(storeId ?? doc.storeId)) ?? 'USD';
    return { exp: isoExponent(cur), currency: cur, inferred: true };
  }
}

function conv(value: any, exp: number, rep: CollectionReport, id: string, field: string): number | undefined {
  if (value === undefined || value === null || typeof value !== 'number') return undefined;
  const scaled = Math.abs(value) * f(exp);
  const dist = Math.abs(scaled - Math.round(scaled));
  const minor = toMinor(value, exp);
  if (dist > NOISE) { if (rep.offGrid.length < 50) rep.offGrid.push({ id, field, value, roundedMinor: minor }); } else if (dist > 0) rep.floatNoise++;
  return minor;
}

/** The set of `$set` entries for a sale: only twins that are absent right now. */
function saleSets(doc: any, ctx: Ctx, rep: CollectionReport) {
  const { exp, currency, inferred } = ctx.expFor(doc, doc.storeId);
  const id = String(doc._id);
  const $set: Record<string, any> = {};
  const put = (path: string, v: number | undefined, current: any) => { if (v !== undefined && (current === undefined || current === null)) $set[path] = Long.fromNumber(v); };
  for (const k of ['subtotal', 'discount', 'tax', 'total', 'changeGiven', 'paymentShortfall', 'refundedAmount']) put(k + 'Minor', conv(doc[k], exp, rep, id, k), doc[k + 'Minor']);
  if ((doc.discountType ?? 'amount') === 'amount' && doc.discountValue) put('discountValueMinor', conv(doc.discountValue, exp, rep, id, 'discountValue'), doc.discountValueMinor);
  (doc.items ?? []).forEach((it: any, i: number) => {
    put(`items.${i}.priceMinor`, conv(it.price, exp, rep, id, `items[${i}].price`), it.priceMinor);
    put(`items.${i}.listPriceMinor`, conv(it.listPrice, exp, rep, id, `items[${i}].listPrice`), it.listPriceMinor);
    put(`items.${i}.lineTotalMinor`, conv(it.lineTotal, exp, rep, id, `items[${i}].lineTotal`), it.lineTotalMinor);
  });
  (doc.payments ?? []).forEach((p: any, i: number) => {
    put(`payments.${i}.amountMinor`, conv(p.amount, exp, rep, id, `payments[${i}].amount`), p.amountMinor);
    put(`payments.${i}.tenderedMinor`, conv(p.tendered, exp, rep, id, `payments[${i}].tendered`), p.tenderedMinor);
  });
  (doc.refunds ?? []).forEach((r: any, i: number) => {
    put(`refunds.${i}.amountMinor`, conv(r.amount, exp, rep, id, `refunds[${i}].amount`), r.amountMinor);
    (r.tenders ?? []).forEach((t: any, j: number) => put(`refunds.${i}.tenders.${j}.amountMinor`, conv(t.amount, exp, rep, id, `refunds[${i}].tenders[${j}].amount`), t.amountMinor));
  });
  if (inferred) { $set.currency = currency; $set.currencyExponent = exp; $set.currencyInferred = true; }
  return { $set, inferred };
}

const SESSION_COUNTERS = ['cashSales', 'cardSales', 'otherSales', 'totalSales', 'totalRefunds'];

function sessionPlan(doc: any, ctx: Ctx, rep: CollectionReport) {
  const { exp, currency, inferred } = ctx.expFor(doc, doc.storeId);
  const id = String(doc._id);
  const $set: Record<string, any> = {};
  const put = (path: string, v: number | undefined, current: any) => { if (v !== undefined && (current === undefined || current === null)) $set[path] = Long.fromNumber(v); };
  for (const k of ['openingCash', 'closingCash', 'expectedCash', 'cashDifference']) put(k + 'Minor', conv(doc[k], exp, rep, id, k), doc[k + 'Minor']);
  (doc.cashAdjustments ?? []).forEach((a: any, i: number) => put(`cashAdjustments.${i}.amountMinor`, conv(a.amount, exp, rep, id, `cashAdjustments[${i}].amount`), a.amountMinor));
  const cr = doc.cardReconciliation;
  if (cr) for (const k of ['slipTotal', 'expectedCard', 'variance']) put(`cardReconciliation.${k}Minor`, conv(cr[k], exp, rep, id, `cardReconciliation.${k}`), cr[k + 'Minor']);
  if (inferred) { $set.currency = currency; $set.currencyExponent = exp; $set.currencyInferred = true; }
  // counters: an atomic pipeline (a live `$add` and this fill cannot overwrite each other)
  const pipelineSet: Record<string, any> = {};
  for (const k of SESSION_COUNTERS) {
    const v = doc[k];
    if (typeof v === 'number') conv(v, exp, rep, id, k); // off-grid report only
    if (doc[k + 'Minor'] === undefined || doc[k + 'Minor'] === null) {
      pipelineSet[k + 'Minor'] = { $ifNull: ['$' + k + 'Minor', { $toLong: { $round: [{ $multiply: [{ $ifNull: ['$' + k, 0] }, f(exp)] }, 0] } }] };
    }
  }
  return { $set, pipelineSet, inferred, exp };
}

function simpleSets(doc: any, ctx: Ctx, rep: CollectionReport, fields: string[], nested?: { arr: string; fields: string[] }) {
  const { exp, currency, inferred } = ctx.expFor(doc, doc.storeId);
  const id = String(doc._id);
  const $set: Record<string, any> = {};
  const put = (path: string, v: number | undefined, current: any) => { if (v !== undefined && (current === undefined || current === null)) $set[path] = Long.fromNumber(v); };
  for (const k of fields) put(k + 'Minor', conv(doc[k], exp, rep, id, k), doc[k + 'Minor']);
  if (nested) (doc[nested.arr] ?? []).forEach((e: any, i: number) => nested.fields.forEach((k) => put(`${nested.arr}.${i}.${k}Minor`, conv(e[k], exp, rep, id, `${nested.arr}[${i}].${k}`), e[k + 'Minor'])));
  if (inferred && doc.currencyExponent === undefined) { /* payments/refunds carry their own snapshot; nothing to infer here */ }
  void currency;
  return { $set, inferred };
}

async function run(db: Db, opts: BackfillOptions, apply: boolean): Promise<BackfillReport> {
  const batchSize = opts.batchSize ?? 500;
  const now = opts.now ?? (() => new Date());
  const ctx = new Ctx(db);
  await ctx.load();
  let remaining = opts.maxDocs ?? Infinity;
  const reports: CollectionReport[] = [];
  const checkpoints = db.collection(G1B.checkpoints);

  const defs: Array<{ name: string; filter: any }> = [
    { name: G1B.sales, filter: { totalMinor: { $exists: false } } },
    { name: G1B.sessions, filter: { $or: [{ openingCashMinor: { $exists: false } }, { totalSalesMinor: { $exists: false } }, { cashSalesMinor: { $exists: false } }] } },
    { name: G1B.payments, filter: { amountMinor: { $exists: false } } },
    { name: G1B.refunds, filter: { amountMinor: { $exists: false } } },
    { name: G1B.stores, filter: { registers: { $elemMatch: { defaultFloatCash: { $exists: true }, defaultFloatCashMinor: { $exists: false } } } } },
  ];

  for (const def of defs) {
    const coll = db.collection(def.name);
    const rep: CollectionReport = { collection: def.name, totalDocs: await coll.estimatedDocumentCount(), candidates: 0, written: 0, conflictsRetried: 0, skippedNoExponent: 0, currencyInferred: 0, floatNoise: 0, offGrid: [] };
    reports.push(rep);
    let lastId: any = null;
    if (opts.resume && apply) { const cp: any = await checkpoints.findOne({ _id: def.name as any }); if (cp?.lastId) lastId = cp.lastId; }
    const started = Date.now();
    let scanned = 0;
    for (;;) {
      if (remaining <= 0) break;
      const q = lastId ? { $and: [def.filter, { _id: { $gt: lastId } }] } : def.filter;
      const batch = await coll.find(q).sort({ _id: 1 }).limit(Math.min(batchSize, remaining === Infinity ? batchSize : remaining)).toArray();
      if (batch.length === 0) break;
      const processDoc = async (doc: any) => {
        rep.candidates++; scanned++;
        if (def.name === G1B.stores) {
          // registers: float in the store's base currency
          const exp = isoExponent(ctx.baseCurrency.get(String(doc._id)) ?? 'USD');
          const $set: Record<string, any> = {};
          (doc.registers ?? []).forEach((r: any, i: number) => {
            if (typeof r.defaultFloatCash === 'number' && (r.defaultFloatCashMinor === undefined || r.defaultFloatCashMinor === null)) { const m = conv(r.defaultFloatCash, exp, rep, String(doc._id), `registers[${i}].defaultFloatCash`); if (m !== undefined) $set[`registers.${i}.defaultFloatCashMinor`] = Long.fromNumber(m); }
          });
          if (apply && Object.keys($set).length) {
            let ok = false;
            for (let attempt = 0; attempt < 5 && !ok; attempt++) {
              const cur: any = attempt === 0 ? doc : await coll.findOne({ _id: doc._id });
              if (!cur) break;
              await opts.beforeWrite?.(def.name, cur);
              const r = await coll.updateOne({ _id: doc._id, registers: { $size: (cur.registers ?? []).length } }, { $set: { ...$set, minorBackfilledAt: now() } });
              ok = r.matchedCount === 1; if (!ok) rep.conflictsRetried++;
            }
            if (ok) rep.written++;
          }
        } else if (def.name === G1B.sessions) {
          const plan = sessionPlan(doc, ctx, rep);
          if (plan.inferred) rep.currencyInferred++;
          if (apply) {
            let ok = false;
            for (let attempt = 0; attempt < 5 && !ok; attempt++) {
              const cur: any = attempt === 0 ? doc : await coll.findOne({ _id: doc._id });
              if (!cur) break;
              const p = attempt === 0 ? plan : sessionPlan(cur, ctx, { ...rep, offGrid: [], floatNoise: 0 } as any);
              await opts.beforeWrite?.(def.name, cur);
              // 1) the non-hot fields: guarded by what they were computed from
              if (Object.keys(p.$set).length) {
                const guard: any = { _id: doc._id, status: cur.status };
                if (Array.isArray(cur.cashAdjustments)) guard.cashAdjustments = { $size: cur.cashAdjustments.length };
                for (const k of ['openingCash', 'closingCash', 'expectedCash', 'cashDifference']) if (cur[k] !== undefined) guard[k] = cur[k];
                const r = await coll.updateOne(guard, { $set: p.$set });
                if (r.matchedCount !== 1) { rep.conflictsRetried++; continue; }
              }
              // 2) the hot counters: one atomic pipeline update, never a read-modify-write
              await coll.updateOne({ _id: doc._id }, [{ $set: { ...p.pipelineSet, minorBackfilledAt: { $ifNull: ['$minorBackfilledAt', now()] } } }] as any);
              ok = true;
            }
            if (ok) rep.written++;
          }
        } else {
          let plan: { $set: Record<string, any>; inferred: boolean };
          if (def.name === G1B.sales) plan = saleSets(doc, ctx, rep);
          else if (def.name === G1B.payments) plan = simpleSets(doc, ctx, rep, ['amount', 'tendered']);
          else plan = simpleSets(doc, ctx, rep, ['amount'], { arr: 'tenders', fields: ['amount'] });
          if (plan.inferred && def.name === G1B.sales) rep.currencyInferred++;
          if (apply && Object.keys(plan.$set).length) {
            let ok = false;
            for (let attempt = 0; attempt < 5 && !ok; attempt++) {
              const cur: any = attempt === 0 ? doc : await coll.findOne({ _id: doc._id });
              if (!cur) break;
              const p = attempt === 0 ? plan : (def.name === G1B.sales ? saleSets(cur, ctx, { ...rep, offGrid: [], floatNoise: 0 } as any) : plan);
              await opts.beforeWrite?.(def.name, cur);
              const guard: any = { _id: doc._id };
              if (def.name === G1B.sales) {
                Object.assign(guard, { status: cur.status });
                for (const k of ['total', 'refundedAmount']) if (cur[k] !== undefined) guard[k] = cur[k];
                for (const k of ['items', 'payments', 'refunds']) if (Array.isArray(cur[k])) guard[k] = { $size: cur[k].length };
              }
              const r = await coll.updateOne(guard, { $set: { ...p.$set, minorBackfilledAt: now() } });
              ok = r.matchedCount === 1; if (!ok) rep.conflictsRetried++;
            }
            if (ok) rep.written++;
          }
        }
      };
      // documents are independent: a bounded number of guarded writes in flight at once (one round trip per document was ~100 docs/s)
      for (let i = 0; i < batch.length; i += CONCURRENCY) {
        const chunk = batch.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map(processDoc));
        lastId = chunk[chunk.length - 1]._id;
        remaining -= chunk.length;
        if (remaining <= 0) break;
      }
      if (apply) await checkpoints.updateOne({ _id: def.name as any }, { $set: { lastId, updatedAt: now() } }, { upsert: true });
      if (batch.length < batchSize && remaining > 0) break;
    }
    const secs = (Date.now() - started) / 1000;
    if (scanned > 0 && secs > 0) rep.readComputeDocsPerSec = Math.round(scanned / secs);
  }

  const totalCandidates = reports.reduce((a, r) => a + r.candidates, 0);
  const assumed = 500; // conservative real-run throughput (docs/s): measured 800-1450 docs/s on the dev copy with 25 writes in flight; halved for a loaded production cluster. A timed rehearsal on a restored copy gives the real figure
  return { dryRun: !apply, batchSize, collections: reports, totalCandidates, assumedWriteDocsPerSec: assumed, estimatedSeconds: Math.ceil(totalCandidates / assumed) };
}

export const backfillMinor = (db: Db, opts: BackfillOptions): Promise<BackfillReport> => run(db, opts, !opts.dryRun);

// ───────────────────────────────── reverse ─────────────────────────────────
export interface RollbackReport { collection: string; rows: number }

export async function backfillMinorDown(db: Db, opts: { dryRun: boolean }): Promise<RollbackReport[]> {
  const out: RollbackReport[] = [];
  const marked = { minorBackfilledAt: { $exists: true } };
  const unsetTop = (names: string[]) => Object.fromEntries(names.flatMap((n) => [[n + 'Minor', '']]));
  const jobs: Array<{ name: string; top: string[]; arrays: Array<{ arr: string; fields: string[]; nested?: { arr: string; fields: string[] } }>; extra?: string[] }> = [
    { name: G1B.sales, top: ['subtotal', 'discount', 'tax', 'total', 'changeGiven', 'paymentShortfall', 'refundedAmount', 'discountValue'], arrays: [{ arr: 'items', fields: ['price', 'listPrice', 'lineTotal'] }, { arr: 'payments', fields: ['amount', 'tendered'] }, { arr: 'refunds', fields: ['amount'], nested: { arr: 'tenders', fields: ['amount'] } }] },
    { name: G1B.sessions, top: ['openingCash', 'closingCash', 'expectedCash', 'cashDifference', 'cashSales', 'cardSales', 'otherSales', 'totalSales', 'totalRefunds'], arrays: [{ arr: 'cashAdjustments', fields: ['amount'] }], extra: ['cardReconciliation.slipTotalMinor', 'cardReconciliation.expectedCardMinor', 'cardReconciliation.varianceMinor'] },
    { name: G1B.payments, top: ['amount', 'tendered'], arrays: [] },
    { name: G1B.refunds, top: ['amount'], arrays: [{ arr: 'tenders', fields: ['amount'] }] },
  ];
  for (const j of jobs) {
    const coll = db.collection(j.name);
    const rows = await coll.countDocuments(marked);
    out.push({ collection: j.name, rows });
    if (opts.dryRun || rows === 0) continue;
    // arrays first (positional unset needs the array to exist), then the rest
    for (const a of j.arrays) {
      const unset: Record<string, ''> = {};
      for (const fld of a.fields) unset[`${a.arr}.$[].${fld}Minor`] = '';
      await coll.updateMany({ ...marked, [a.arr]: { $type: 'array', $ne: [] } }, { $unset: unset });
      if (a.nested) {
        // refunds[].tenders[].amountMinor: unset through a pipeline (nested positional)
        await coll.updateMany({ ...marked, [a.arr]: { $type: 'array', $ne: [] } }, [{ $set: { [a.arr]: { $map: { input: `$${a.arr}`, as: 'e', in: { $mergeObjects: ['$$e', { [a.nested.arr]: { $map: { input: { $ifNull: [`$$e.${a.nested.arr}`, []] }, as: 't', in: { $unsetField: { field: 'amountMinor', input: '$$t' } } } } }] } } } } }] as any);
      }
    }
    const unset: Record<string, ''> = { ...unsetTop(j.top), minorBackfilledAt: '', ...Object.fromEntries((j.extra ?? []).map((e) => [e, ''])) };
    await coll.updateMany(marked, { $unset: unset });
    // rows whose currency snapshot the backfill inferred: remove what it wrote
    await coll.updateMany({ currencyInferred: true }, { $unset: { currency: '', currencyExponent: '', currencyInferred: '' } });
  }
  // stores: registers[].defaultFloatCashMinor
  const stores = db.collection(G1B.stores);
  const sRows = await stores.countDocuments(marked);
  out.push({ collection: G1B.stores, rows: sRows });
  if (!opts.dryRun && sRows > 0) {
    await stores.updateMany({ ...marked, registers: { $type: 'array', $ne: [] } }, { $unset: { 'registers.$[].defaultFloatCashMinor': '', minorBackfilledAt: '' } });
  }
  if (!opts.dryRun) await db.collection(G1B.checkpoints).deleteMany({});
  return out;
}
