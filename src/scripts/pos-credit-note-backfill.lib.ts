/* eslint-disable prettier/prettier */
import { Long, ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { isoExponent, toMinor } from '../common/money-minor.util';
import { effectivePayments } from '../pos/pos-money.util';
import { lineBreakdown, returnLineAmounts } from '../pos/pos-documents.util';
import type { LineBreakdown } from '../pos/pos-documents.util';

/**
 * Credit-note backfill: every refund and every void made BEFORE credit notes existed (G2.5) gets a credit note in a SEPARATE series `CN-B000001…`
 * so the gap-free real series `CN-000001…` of live documents is never disturbed and an auditor can always tell them apart.
 *
 *  - MARKED: each note carries `backfill { backfilledAt, originalType: 'refund'|'void', originalId, batchId, amountDeltaMinor }`, number `CN-B…`,
 *    a NEGATIVE `seq` (so the unique per-store seq index of the real series cannot clash) and `createdAt` = the time of the original refund / void.
 *  - IDEMPOTENT: only refunds / voids that have no note yet are touched (a refund is found by `refundId`, a void by `{saleId, kind:'void'}`); a unique index
 *    (`uniq_cn_refund`) also stops a race. Re-running writes 0.
 *  - RESUMABLE: notes are numbered in chronological order per store; a run that stopped part-way continues with the next number (`maxDocs` slices a run).
 *  - REVERSIBLE: `down` deletes exactly the notes carrying `backfill` and the audit events this script wrote — nothing else is created, nothing else is changed
 *    (stock, shift counters, refunds, sales and the real counters are never touched), so up + down restores the database byte for byte.
 *  - SAFE TARGET: refuses a database whose name lacks "dev"/"test" unless BOTH `--production` and `--i-have-a-backup` are given (same rule as G1b).
 *  - PRICING: the same cumulative proration as a live return (`returnLineAmounts`), per line, in the order the refunds happened; the note always equals what was
 *    paid out — a difference to the proration (an old sale priced by the old rule) is put on the last line and reported as `amountDeltaMinor`.
 *  - Nothing is guessed: a refund / void that cannot be reconstructed (sale gone, unknown line, more units than were sold) is LISTED and skipped.
 */
export const CNB = { refunds: 'posrefunds', sales: 'sales', notes: 'poscreditnotes', stores: 'stores', audit: 'posauditlogs' } as const;
export const BACKFILL_AUDIT_ACTION = 'credit_notes_backfilled';

export interface CnBackfillOptions {
  dryRun: boolean;
  /** stop after this many notes in total (a crash / an operator running in slices) */
  maxDocs?: number;
  now?: () => Date;
  batchId?: string;
}
export interface StoreReport {
  storeId: string;
  refundCandidates: number;
  voidCandidates: number;
  written: number;
  firstNumber: string | null;
  lastNumber: string | null;
  deltas: Array<{ originalType: 'refund' | 'void'; originalId: string; deltaMinor: number }>;
  legacyMajorAmounts: number; // refunds that only had the decimal amount (written before the minor twins)
  skipped: Array<{ originalType: 'refund' | 'void'; originalId: string; reason: string }>;
}
export interface CnBackfillReport { dryRun: boolean; batchId: string; stores: StoreReport[]; totalCandidates: number; totalWritten: number; totalSkipped: number }

export { assertSafeTarget } from './pos-g1b-minor-backfill.lib';

const pad = (n: number) => String(n).padStart(6, '0');
const when = (d: any): number => (d ? new Date(d).getTime() : 0);

type Item = any;
function breakdownOf(sale: any, exp: number): LineBreakdown[] {
  const items: Item[] = sale.items ?? [];
  const stored = items.length > 0 && items.every((i) => i.netMinor != null && i.taxMinor != null);
  if (stored) {
    return items.map((i) => {
      const gross = Number(i.lineTotalMinor ?? toMinor(i.lineTotal ?? Number(i.price) * Number(i.qty), exp));
      const disc = Number(i.discountShareMinor ?? gross - Number(i.netMinor));
      return { grossMinor: gross, discountMinor: disc, netMinor: Number(i.netMinor), taxMinor: Number(i.taxMinor), totalMinor: Number(i.netMinor) + Number(i.taxMinor) };
    });
  }
  return lineBreakdown(
    items.map((i) => ({ grossMinor: Number(i.lineTotalMinor ?? toMinor(i.lineTotal ?? Number(i.price) * Number(i.qty), exp)), taxable: i.taxCategory !== 'exempt' })),
    Number(sale.discountMinor ?? toMinor(sale.discount ?? 0, exp)), Number(sale.taxMinor ?? toMinor(sale.tax ?? 0, exp)),
  );
}

interface Candidate { type: 'refund' | 'void'; id: string; saleId: string; at: number; refund?: any; sale?: any }

export async function backfillCreditNotes(db: Db, opts: CnBackfillOptions): Promise<CnBackfillReport> {
  const now = opts.now ?? (() => new Date());
  const batchId = opts.batchId ?? `cnb-${now().toISOString()}`;
  const baseCurrency = new Map<string, string>();
  for await (const s of db.collection(CNB.stores).find({}, { projection: { baseCurrency: 1 } })) baseCurrency.set(String(s._id), String((s as any).baseCurrency ?? 'USD'));

  // what already has a note
  const haveRefundNote = new Set<string>();
  for await (const n of db.collection(CNB.notes).find({ refundId: { $type: 'string' } }, { projection: { refundId: 1 } })) haveRefundNote.add(String((n as any).refundId));
  const haveVoidNote = new Set<string>();
  for await (const n of db.collection(CNB.notes).find({ kind: 'void' }, { projection: { saleId: 1 } })) haveVoidNote.add(String((n as any).saleId));

  // every refund, grouped per sale and ordered, so the cumulative proration sees the earlier refunds (with or without a note)
  const refundsBySale = new Map<string, any[]>();
  for await (const r of db.collection(CNB.refunds).find({}).sort({ createdAt: 1, _id: 1 })) {
    const k = String((r as any).saleId);
    (refundsBySale.get(k) ?? refundsBySale.set(k, []).get(k)!).push(r);
  }
  const perStore = new Map<string, Candidate[]>();
  const add = (storeId: string, c: Candidate) => (perStore.get(storeId) ?? perStore.set(storeId, []).get(storeId)!).push(c);
  for (const list of refundsBySale.values()) {
    for (const r of list) if (!haveRefundNote.has(String(r._id))) add(String(r.storeId), { type: 'refund', id: String(r._id), saleId: String(r.saleId), at: when(r.createdAt), refund: r });
  }
  for await (const s of db.collection(CNB.sales).find({ status: 'voided' })) {
    if (!haveVoidNote.has(String(s._id))) add(String((s as any).storeId), { type: 'void', id: String(s._id), saleId: String(s._id), at: when((s as any).voidedAt ?? (s as any).createdAt), sale: s });
  }

  const report: CnBackfillReport = { dryRun: opts.dryRun, batchId, stores: [], totalCandidates: 0, totalWritten: 0, totalSkipped: 0 };
  let budget = opts.maxDocs ?? Infinity;
  const saleCache = new Map<string, any>();
  const loadSale = async (id: string) => {
    if (!saleCache.has(id)) saleCache.set(id, await db.collection(CNB.sales).findOne({ _id: new ObjectId(id) }));
    return saleCache.get(id);
  };

  for (const [storeId, list] of [...perStore.entries()].sort()) {
    list.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const rep: StoreReport = { storeId, refundCandidates: list.filter((c) => c.type === 'refund').length, voidCandidates: list.filter((c) => c.type === 'void').length, written: 0, firstNumber: null, lastNumber: null, deltas: [], legacyMajorAmounts: 0, skipped: [] };
    report.stores.push(rep);
    report.totalCandidates += list.length;
    // the next number continues after the highest backfilled note of this store (chronological order keeps it consistent across a resumed run)
    const last: any = await db.collection(CNB.notes).find({ storeId, backfill: { $ne: null } }).sort({ seq: 1 }).limit(1).next(); // seq is NEGATIVE: the most negative is the latest
    let k = last ? -Number(last.seq) : 0;

    for (const c of list) {
      const skip = (reason: string) => { rep.skipped.push({ originalType: c.type, originalId: c.id, reason }); report.totalSkipped++; };
      const sale = c.type === 'void' ? c.sale : await loadSale(c.saleId);
      if (!sale) { skip('sale_missing'); continue; }
      const exp: number = sale.currencyExponent ?? c.refund?.currencyExponent ?? isoExponent(baseCurrency.get(storeId) ?? 'USD');
      const currency: string = String(sale.currency ?? c.refund?.currency ?? baseCurrency.get(storeId) ?? 'USD').toUpperCase();
      const items: Item[] = sale.items ?? [];
      const bd = breakdownOf(sale, exp);

      // which units, and how many came back before this one
      const returnedBefore = items.map(() => 0);
      let wanted: Array<{ idx: number; qty: number }> = [];
      if (c.type === 'refund') {
        const earlier = (refundsBySale.get(c.saleId) ?? []).filter((r) => when(r.createdAt) < c.at || (when(r.createdAt) === c.at && String(r._id) < c.id));
        for (const r of earlier) for (const it of r.items ?? []) { const i = items.findIndex((x) => String(x._id) === String(it.saleItemId)); if (i >= 0) returnedBefore[i] += Number(it.qty) || 0; }
        if ((c.refund.items ?? []).length) {
          let bad = false;
          for (const it of c.refund.items) { const i = items.findIndex((x) => String(x._id) === String(it.saleItemId)); if (i < 0) { bad = true; break; } wanted.push({ idx: i, qty: Number(it.qty) || 0 }); }
          if (bad) { skip('unknown_sale_line'); continue; }
        } else {
          wanted = items.map((it, idx) => ({ idx, qty: it.qty - returnedBefore[idx] })).filter((w) => w.qty > 0);
        }
      } else {
        wanted = items.map((it, idx) => ({ idx, qty: it.qty }));
      }
      if (wanted.some((w) => w.qty <= 0 || w.qty > items[w.idx].qty - returnedBefore[w.idx])) { skip('more_units_than_were_sold'); continue; }
      if (!wanted.length) { skip('nothing_to_return'); continue; }

      const amounts = wanted.map((w) => ({ ...w, a: { ...returnLineAmounts(bd[w.idx], items[w.idx].qty, returnedBefore[w.idx], w.qty) } }));
      const sum = amounts.reduce((s2, x) => s2 + x.a.totalMinor, 0);
      let paidMinor: number;
      let tenders: Array<{ method: string; amountMinor: number }>;
      if (c.type === 'refund') {
        if (c.refund.amountMinor == null) rep.legacyMajorAmounts++;
        paidMinor = Number(c.refund.amountMinor ?? toMinor(Number(c.refund.amount), exp));
        tenders = (c.refund.tenders ?? []).map((t: any) => ({ method: t.method, amountMinor: Number(t.amountMinor ?? toMinor(Number(t.amount), exp)) }));
      } else {
        paidMinor = Number(sale.totalMinor ?? toMinor(Number(sale.total), exp));
        tenders = effectivePayments(sale).map((l: any) => ({ method: l.method, amountMinor: toMinor(Number(l.amount), exp) }));
      }
      const delta = paidMinor - sum;
      if (delta !== 0) { const lastLine = amounts[amounts.length - 1].a; lastLine.netMinor += delta; lastLine.totalMinor += delta; rep.deltas.push({ originalType: c.type, originalId: c.id, deltaMinor: delta }); }

      if (budget <= 0) continue; // sliced run: counted as a candidate, not written
      k++;
      const number = `CN-B${pad(k)}`;
      const L = (v: number) => Long.fromNumber(v);
      const lines = amounts.map((x) => {
        const it = items[x.idx];
        return {
          saleItemId: String(it._id), productId: it.productId ?? null, variantId: it.variantId ?? null, name: it.name, sku: it.sku ?? '', hsCode: it.hsCode ?? null, taxCategory: it.taxCategory ?? 'standard', qty: x.qty,
          unitPriceMinor: L(Number(it.priceMinor ?? toMinor(Number(it.price), exp))), grossMinor: L(x.a.grossMinor), discountMinor: L(x.a.discountMinor), netMinor: L(x.a.netMinor), taxMinor: L(x.a.taxMinor), totalMinor: L(x.a.totalMinor),
          restock: !it.isCustom, restockReason: null, // the old code always put non-custom stock back
        };
      });
      const tot = (key: 'grossMinor' | 'discountMinor' | 'netMinor' | 'taxMinor' | 'totalMinor') => L(amounts.reduce((s2, x) => s2 + x.a[key], 0));
      const completes = items.every((it, idx) => returnedBefore[idx] + (wanted.find((w) => w.idx === idx)?.qty ?? 0) >= it.qty);
      const doc = {
        _id: new ObjectId(), storeId, number, seq: -k, saleId: String(sale._id), saleNumber: sale.saleNumber ?? null,
        invoiceNumber: sale.invoice?.number ?? null, invoiceIssuedAt: sale.invoice?.issuedAt ?? null,
        kind: c.type === 'void' ? 'void' : 'return', scope: c.type === 'void' || completes ? 'full' : 'partial', refundId: c.type === 'refund' ? c.id : null,
        reasonCode: (c.type === 'refund' ? c.refund.reasonCode : sale.voidReasonCode) ?? null, reason: (c.type === 'refund' ? c.refund.reason : sale.voidReason) ?? null,
        lines, grossMinor: tot('grossMinor'), discountMinor: tot('discountMinor'), netMinor: tot('netMinor'), taxMinor: tot('taxMinor'), totalMinor: tot('totalMinor'),
        currency, currencyExponent: exp, tenders: tenders.map((t) => ({ method: t.method, amountMinor: L(t.amountMinor) })),
        seller: sale.invoice?.seller ?? null, customerName: sale.customerName ?? null,
        employeeId: (c.type === 'refund' ? c.refund.employeeId : sale.voidedBy) ?? null, approvedBy: null, approvalReasons: [],
        registerId: (c.type === 'refund' ? c.refund.registerId : null) ?? null, sessionId: (c.type === 'refund' ? c.refund.sessionId : null) ?? null,
        saleRegisterId: sale.registerId ?? null, saleSessionId: sale.sessionId ?? null,
        fiscal: { status: 'not_enabled', externalInvoiceNumber: null, qrPayload: null, attempts: 0, lastError: null },
        backfill: { backfilledAt: now(), originalType: c.type, originalId: c.id, batchId, ...(delta !== 0 ? { amountDeltaMinor: delta } : {}) },
        createdAt: new Date(c.at || now().getTime()), __v: 0,
      };
      if (!opts.dryRun) {
        try { await db.collection(CNB.notes).insertOne(doc as any); } catch (e: any) { if (e?.code === 11000) { k--; continue; } throw e; } // lost a race with another run: it is already done
      }
      rep.written++; report.totalWritten++; budget--;
      rep.firstNumber ??= number; rep.lastNumber = number;
    }
    if (!opts.dryRun && rep.written > 0) {
      await db.collection(CNB.audit).insertOne({ _id: new ObjectId(), storeId, employeeId: null, action: BACKFILL_AUDIT_ACTION, targetId: batchId, targetType: 'backfill', metadata: { batchId, notes: rep.written, first: rep.firstNumber, last: rep.lastNumber, skipped: rep.skipped.length }, createdAt: now(), __v: 0 } as any);
    }
  }
  return report;
}

/** Removes exactly what `up` added: the backfilled notes and the audit events of the backfill. Needs a user allowed to delete from the append-only collections. */
export async function backfillCreditNotesDown(db: Db, opts: { dryRun: boolean }): Promise<{ notes: number; audit: number }> {
  const notes = await db.collection(CNB.notes).countDocuments({ backfill: { $ne: null } });
  const audit = await db.collection(CNB.audit).countDocuments({ action: BACKFILL_AUDIT_ACTION });
  if (!opts.dryRun) {
    await db.collection(CNB.notes).deleteMany({ backfill: { $ne: null } });
    await db.collection(CNB.audit).deleteMany({ action: BACKFILL_AUDIT_ACTION });
  }
  return { notes, audit };
}
