/* eslint-disable prettier/prettier */
import { Long } from 'mongodb';
import type { Db } from 'mongodb';
import { isoExponent, toMinor } from '../common/money-minor.util';
export { assertSafeTarget } from './pos-g1b-minor-backfill.lib';

/**
 * G3.0 backfill of the supply-side minor twins (purchase orders + lines, supplier returns + lines, lot costs, variant costs) on rows written before
 * the dual-write. Same guarantees as the G1b backfill: IDEMPOTENT (only rows still missing a twin; a row a live write already twinned is skipped),
 * SAFE UNDER LIVE TRAFFIC (every write is guarded by the values it was computed from; a lost race is skipped and re-run later), RESUMABLE (re-run = continue; `maxDocs` slices),
 * REVERSIBLE (`down` removes only what `up` added: rows carrying `costMinorBackfilledAt`), dry run first, non-dev databases refused without BOTH production flags.
 * Exponent: a purchase order's own `currency`; everything else the STORE's baseCurrency (ISO table — never the storefront display decimals).
 * A supplier return written before it kept its currency gets the store's currency written too (marked, removed again by `down`).
 */
export const G3C = { po: 'purchaseorders', returns: 'supplierreturns', lots: 'stocklots', variants: 'productvariants', stores: 'stores', products: 'products' } as const;
export interface CostBackfillOptions { dryRun: boolean; batchSize?: number; maxDocs?: number; now?: () => Date }
export interface CostCollectionReport { collection: string; totalDocs: number; candidates: number; written: number; skippedRaced: number; offGrid: Array<{ id: string; field: string; value: number; roundedMinor: number }>; currencyFilled: number; skippedNoStore: number }
const NOISE = 1e-6;
const L = (n: number) => Long.fromNumber(n);

export async function backfillCostMinor(db: Db, opts: CostBackfillOptions): Promise<{ dryRun: boolean; collections: CostCollectionReport[] }> {
  const now = (opts.now ?? (() => new Date()))();
  const batch = opts.batchSize ?? 500;
  let budget = opts.maxDocs ?? Infinity;
  const baseCurrency = new Map<string, string>();
  for await (const s of db.collection(G3C.stores).find({}, { projection: { baseCurrency: 1 } })) baseCurrency.set(String(s._id), String((s as any).baseCurrency ?? 'USD'));
  const productStore = new Map<string, string>();

  const rep = (collection: string, totalDocs: number): CostCollectionReport => ({ collection, totalDocs, candidates: 0, written: 0, skippedRaced: 0, offGrid: [], currencyFilled: 0, skippedNoStore: 0 });
  const twin = (r: CostCollectionReport, id: string, field: string, v: any, exp: number): Long | null => {
    if (v === undefined || v === null || typeof v !== 'number') return null;
    const scaled = Math.abs(v) * 10 ** exp;
    if (Math.abs(scaled - Math.round(scaled)) > NOISE && r.offGrid.length < 50) r.offGrid.push({ id, field, value: v, roundedMinor: toMinor(v, exp) });
    return L(toMinor(v, exp));
  };
  const out: CostCollectionReport[] = [];
  const flush = async (col: string, ops: any[], r: CostCollectionReport) => {
    if (!ops.length || opts.dryRun) { r.written += opts.dryRun ? ops.length : 0; return; }
    const res = await db.collection(col).bulkWrite(ops, { ordered: false });
    r.written += res.modifiedCount;
    r.skippedRaced += ops.length - res.modifiedCount;
  };

  // purchase orders: own currency
  {
    const col = db.collection(G3C.po); const r = rep(G3C.po, await col.countDocuments({})); out.push(r);
    let ops: any[] = [];
    for await (const d of col.find({ subtotalMinor: { $exists: false } })) {
      r.candidates++; if (budget <= 0) continue;
      const exp = isoExponent((d as any).currency);
      const id = String(d._id);
      const $set: any = { subtotalMinor: twin(r, id, 'subtotal', (d as any).subtotal ?? 0, exp), shippingCostMinor: twin(r, id, 'shippingCost', (d as any).shippingCost ?? 0, exp), taxCostMinor: twin(r, id, 'taxCost', (d as any).taxCost ?? 0, exp), totalMinor: twin(r, id, 'total', (d as any).total ?? 0, exp), costMinorBackfilledAt: now };
      ((d as any).items ?? []).forEach((it: any, i: number) => { $set[`items.${i}.unitCostMinor`] = twin(r, id, `items[${i}].unitCost`, it.unitCost ?? 0, exp); });
      ops.push({ updateOne: { filter: { _id: d._id, subtotalMinor: { $exists: false }, total: (d as any).total ?? 0 }, update: { $set } } });
      budget--;
      if (ops.length >= batch) { await flush(G3C.po, ops, r); ops = []; }
    }
    await flush(G3C.po, ops, r);
  }
  // supplier returns: the store's currency (filled in when absent)
  {
    const col = db.collection(G3C.returns); const r = rep(G3C.returns, await col.countDocuments({})); out.push(r);
    let ops: any[] = [];
    for await (const d of col.find({ totalCreditMinor: { $exists: false } })) {
      r.candidates++; if (budget <= 0) continue;
      const cur = (d as any).currency ?? baseCurrency.get(String((d as any).storeId));
      if (!cur) { r.skippedNoStore++; continue; }
      const exp = isoExponent(cur); const id = String(d._id);
      const $set: any = { totalCreditMinor: twin(r, id, 'totalCredit', (d as any).totalCredit ?? 0, exp), costMinorBackfilledAt: now };
      if (!(d as any).currency) { $set.currency = cur; $set.costMinorBackfilledCurrency = true; r.currencyFilled++; }
      ((d as any).items ?? []).forEach((it: any, i: number) => { $set[`items.${i}.unitCostMinor`] = twin(r, id, `items[${i}].unitCost`, it.unitCost ?? 0, exp); });
      ops.push({ updateOne: { filter: { _id: d._id, totalCreditMinor: { $exists: false }, totalCredit: (d as any).totalCredit ?? 0 }, update: { $set } } });
      budget--;
      if (ops.length >= batch) { await flush(G3C.returns, ops, r); ops = []; }
    }
    await flush(G3C.returns, ops, r);
  }
  // lots + variants: the store's currency
  for (const [name, cost] of [[G3C.lots, 'costPrice'], [G3C.variants, 'costPrice']] as const) {
    const col = db.collection(name); const r = rep(name, await col.countDocuments({})); out.push(r);
    let ops: any[] = [];
    for await (const d of col.find({ [cost]: { $type: 'number' }, costPriceMinor: { $in: [null] } })) { // missing or null
      r.candidates++; if (budget <= 0) continue;
      let storeId: string | undefined = (d as any).storeId ?? undefined;
      if (!storeId && name === G3C.variants && (d as any).productId) {
        const pid = String((d as any).productId);
        if (!productStore.has(pid)) { const p: any = await db.collection(G3C.products).findOne({ _id: (typeof (d as any).productId === 'string' ? (await import('mongodb')).ObjectId.createFromHexString(pid) : (d as any).productId) }, { projection: { storeId: 1 } }); if (p?.storeId) productStore.set(pid, String(p.storeId)); }
        storeId = productStore.get(pid);
      }
      const cur = storeId ? baseCurrency.get(String(storeId)) : undefined;
      if (!cur) { r.skippedNoStore++; continue; }
      const exp = isoExponent(cur);
      ops.push({ updateOne: { filter: { _id: d._id, [cost]: (d as any)[cost], costPriceMinor: { $in: [null] } }, update: { $set: { costPriceMinor: twin(r, String(d._id), cost, (d as any)[cost], exp), costMinorBackfilledAt: now } } } });
      budget--;
      if (ops.length >= batch) { await flush(name, ops, r); ops = []; }
    }
    await flush(name, ops, r);
  }
  return { dryRun: opts.dryRun, collections: out };
}

export async function backfillCostMinorDown(db: Db, opts: { dryRun: boolean }): Promise<Array<{ collection: string; rows: number }>> {
  const res: Array<{ collection: string; rows: number }> = [];
  for (const name of [G3C.po, G3C.returns, G3C.lots, G3C.variants]) {
    const col = db.collection(name);
    const rows = await col.countDocuments({ costMinorBackfilledAt: { $exists: true } });
    res.push({ collection: name, rows });
    if (opts.dryRun || !rows) continue;
    const cursor = col.find({ costMinorBackfilledAt: { $exists: true } });
    for await (const d of cursor) {
      const $unset: any = { costMinorBackfilledAt: '' };
      if (name === G3C.po) Object.assign($unset, { subtotalMinor: '', shippingCostMinor: '', taxCostMinor: '', totalMinor: '' });
      if (name === G3C.returns) { $unset.totalCreditMinor = ''; if ((d as any).costMinorBackfilledCurrency) { $unset.currency = ''; $unset.costMinorBackfilledCurrency = ''; } }
      if (name === G3C.lots) $unset.costPriceMinor = '';
      if (name === G3C.variants) $unset.costPriceMinor = '';
      if (name === G3C.po || name === G3C.returns) ((d as any).items ?? []).forEach((_: any, i: number) => { $unset[`items.${i}.unitCostMinor`] = ''; });
      await col.updateOne({ _id: d._id }, { $unset });
    }
  }
  return res;
}
