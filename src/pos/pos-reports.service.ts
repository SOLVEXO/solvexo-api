/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { isoExponent } from '@/common/money-minor.util';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosAction } from './pos-permissions.config';
import { localDay } from './pos-day.util';
import { deriveRecords } from './pos-attendance.util';
import { isValidTimeZone } from '../analytics/utils/analytics-date.util';

type Req = any;
interface Tokens { employee?: string; approver?: string }
const bad = (code: string, message: string) => new BadRequestException({ statusCode: 400, code, message });
const MAX_DAYS = 366;
/** a sale that happened (a voided sale never happened; held / discarded are not sales) */
const SOLD = ['completed', 'partially_refunded', 'refunded'];

interface Period { from: string; to: string; start: Date; end: Date; days: number }
interface Ctx { storeId: string; tz: string; currency: string; currencyExponent: number; period: Period; previous: Period | null; filters: { registerId?: string; employeeId?: string; locationId?: string }; role: string; employeeId: string | null }
interface LineAgg { qty: number; grossMinor: number; netMinor: number; taxMinor: number; discountMinor: number; costMinor: number; netWithCostMinor: number; netNoCostMinor: number; lines: number }
const zeroLine = (): LineAgg => ({ qty: 0, grossMinor: 0, netMinor: 0, taxMinor: 0, discountMinor: 0, costMinor: 0, netWithCostMinor: 0, netNoCostMinor: 0, lines: 0 });

/**
 * G4.0 / G4.1 — reports for the till, computed LIVE from the ledgers (sales and their lines, credit notes, refunds, expenses, attendance) with aggregation
 * pipelines — nothing new is recorded. Every day boundary is a day in the store's time zone. All money is integer minor units, every response states
 * its currency + exponent. Definitions (owner decision 2):
 *   net sales (ex tax)  = Σ line net of sales made in the period − Σ net of RETURN credit notes issued in the period (a voided sale never happened)
 *   cost of goods sold  = Σ qty × the line's WAC snapshot − returns at the SALE's snapshot; lines with no cost are listed as "cost unknown", never imputed
 *   gross margin        = net sales of lines WITH a known cost − their cost (and coverage = the share of net sales that has a cost)
 *   after expenses      = gross margin − expenses recorded in the period (not rejected). SUPPLIER PAYMENTS ARE NOT EXPENSES (the inventory cost is in COGS).
 */
@Injectable()
export class PosReportsService {
  constructor(private readonly db: DatabaseService, private readonly pos: PosService, private readonly auth: PosAuthorizer) {}
  private get r(): any { return this.db.repositories; }

  // ── context ──────────────────────────────────────────────────────────────────
  private periodOf(from: string | undefined, to: string | undefined, tz: string): Period {
    const a = localDay(from, tz); const b = localDay(to ?? from, tz);
    if (b.end <= a.start) throw bad('RANGE_INVALID', 'The end of the period is before its start');
    const days = Math.round((b.end.getTime() - a.start.getTime()) / 86_400_000);
    if (days > MAX_DAYS) throw bad('RANGE_TOO_LONG', `A report covers at most ${MAX_DAYS} days`);
    return { from: a.key, to: b.key, start: a.start, end: b.end, days };
  }
  private previousOf(p: Period, tz: string): Period {
    const prevTo = localDay(new Date(p.start.getTime() - 1), tz);
    const prevFrom = localDay(new Date(prevTo.start.getTime() - (p.days - 1) * 86_400_000 + 3_600_000 * 12), tz); // noon-anchored so DST days do not shift the count
    return { from: prevFrom.key, to: prevTo.key, start: prevFrom.start, end: prevTo.end, days: p.days };
  }
  private async ctx(req: Req, storeId: string, q: any, t: Tokens, action: PosAction): Promise<Ctx> {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    const a = await this.auth.authorize(req, { storeId, action, employeeToken: t.employee, approverToken: t.approver });
    const store: any = await this.r.storeModel.findById(storeId).select('baseCurrency timezone country').lean();
    const tz = await this.pos.storeTz(storeId);
    const currency = String(store?.baseCurrency || 'USD').toUpperCase();
    const period = this.periodOf(q?.from, q?.to, tz);
    const filters: Ctx['filters'] = {};
    for (const k of ['registerId', 'employeeId', 'locationId'] as const) if (q?.[k]) filters[k] = String(q[k]);
    return { storeId, tz, currency, currencyExponent: isoExponent(currency), period, previous: q?.compare === 'previous' || q?.compare === true ? this.previousOf(period, tz) : null, filters, role: a.role, employeeId: a.employeeId };
  }
  private head(c: Ctx, p: Period = c.period) { return { currency: c.currency, currencyExponent: c.currencyExponent, timeZone: c.tz, period: { from: p.from, to: p.to, days: p.days }, filters: c.filters }; }
  private saleMatch(c: Ctx, p: Period) {
    const m: any = { storeId: c.storeId, createdAt: { $gte: p.start, $lt: p.end }, status: { $in: SOLD } };
    if (c.filters.registerId) m.registerId = c.filters.registerId;
    if (c.filters.employeeId) m.employeeId = c.filters.employeeId;
    if (c.filters.locationId) m.locationId = c.filters.locationId;
    return m;
  }
  private noteMatch(c: Ctx, p: Period) {
    const m: any = { storeId: c.storeId, kind: 'return', createdAt: { $gte: p.start, $lt: p.end } };
    if (c.filters.registerId) m.registerId = c.filters.registerId;
    if (c.filters.employeeId) m.employeeId = c.filters.employeeId;
    return m;
  }

  // ── building blocks ──────────────────────────────────────────────────────────
  /** Sale lines grouped by `key` (a Mongo expression over `$items` / the sale), one pass, all in the database. */
  private async lineAgg(c: Ctx, p: Period, key: any): Promise<Map<string, LineAgg & { label?: string }>> {
    const net = { $ifNull: ['$items.netMinor', { $ifNull: ['$items.lineTotalMinor', 0] }] };
    const hasCost = { $ne: [{ $ifNull: ['$items.unitCostMinor', null] }, null] };
    const rows: any[] = await this.r.saleModel.aggregate([
      { $match: this.saleMatch(c, p) },
      { $project: { items: 1, createdAt: 1, employeeId: 1, registerId: 1 } },
      { $unwind: '$items' },
      { $group: {
        _id: key,
        label: { $first: '$items.name' },
        qty: { $sum: '$items.qty' }, lines: { $sum: 1 },
        grossMinor: { $sum: { $ifNull: ['$items.lineTotalMinor', 0] } }, netMinor: { $sum: net }, taxMinor: { $sum: { $ifNull: ['$items.taxMinor', 0] } }, discountMinor: { $sum: { $ifNull: ['$items.discountShareMinor', 0] } },
        costMinor: { $sum: { $cond: [hasCost, { $multiply: ['$items.qty', '$items.unitCostMinor'] }, 0] } },
        netWithCostMinor: { $sum: { $cond: [hasCost, net, 0] } }, netNoCostMinor: { $sum: { $cond: [hasCost, 0, net] } },
      } },
    ]).allowDiskUse(true);
    return new Map(rows.map((x) => [String(x._id), { qty: x.qty, grossMinor: x.grossMinor, netMinor: x.netMinor, taxMinor: x.taxMinor, discountMinor: x.discountMinor, costMinor: x.costMinor, netWithCostMinor: x.netWithCostMinor, netNoCostMinor: x.netNoCostMinor, lines: x.lines, label: x.label }]));
  }
  /** Return credit notes' lines grouped by `keyOf`, with the cost given back at the SALE line's snapshot. */
  private async returnAgg(c: Ctx, p: Period, keyOf: (l: any, note: any, saleLine: any) => string): Promise<Map<string, LineAgg>> {
    const notes: any[] = await this.r.posCreditNoteModel.find(this.noteMatch(c, p)).select('saleId lines createdAt employeeId registerId').lean();
    const saleIds = [...new Set(notes.map((n) => n.saleId))].filter((x) => Types.ObjectId.isValid(x));
    const sales: any[] = saleIds.length ? await this.r.saleModel.find({ _id: { $in: saleIds } }).select('items._id items.unitCostMinor items.productId items.variantId items.name items.isCustom').lean() : [];
    const lineById = new Map<string, any>();
    for (const s of sales) for (const it of s.items ?? []) lineById.set(String(it._id), it);
    const out = new Map<string, LineAgg>();
    for (const n of notes) for (const l of n.lines ?? []) {
      const sl = lineById.get(String(l.saleItemId));
      const k = keyOf(l, n, sl);
      const a = out.get(k) ?? zeroLine();
      const netM = l.netMinor ?? 0; const cost = sl?.unitCostMinor;
      a.qty += l.qty ?? 0; a.lines += 1; a.netMinor += netM; a.taxMinor += l.taxMinor ?? 0; a.grossMinor += l.totalMinor ?? 0;
      if (cost !== null && cost !== undefined) { a.costMinor += (l.qty ?? 0) * cost; a.netWithCostMinor += netM; } else a.netNoCostMinor += netM;
      out.set(k, a);
    }
    return out;
  }
  private minus(a: LineAgg, b: LineAgg | undefined): LineAgg {
    if (!b) return a;
    return { qty: a.qty - b.qty, grossMinor: a.grossMinor - b.grossMinor, netMinor: a.netMinor - b.netMinor, taxMinor: a.taxMinor - b.taxMinor, discountMinor: a.discountMinor, costMinor: a.costMinor - b.costMinor, netWithCostMinor: a.netWithCostMinor - b.netWithCostMinor, netNoCostMinor: a.netNoCostMinor - b.netNoCostMinor, lines: a.lines };
  }
  private margin(x: LineAgg) {
    const gm = x.netWithCostMinor - x.costMinor;
    return { grossMarginMinor: gm, marginPercent: x.netWithCostMinor ? Math.round((gm / x.netWithCostMinor) * 1000) / 10 : null, costCoveragePercent: x.netMinor ? Math.round((x.netWithCostMinor / x.netMinor) * 1000) / 10 : null, costUnknownNetMinor: x.netNoCostMinor };
  }
  private async saleTotals(c: Ctx, p: Period) {
    const [s] = await this.r.saleModel.aggregate([
      { $match: this.saleMatch(c, p) },
      { $group: { _id: null, transactions: { $sum: 1 }, totalMinor: { $sum: { $ifNull: ['$totalMinor', 0] } }, taxMinor: { $sum: { $ifNull: ['$taxMinor', 0] } }, discountMinor: { $sum: { $ifNull: ['$discountMinor', 0] } } } },
    ]);
    const [rf] = await this.r.posCreditNoteModel.aggregate([{ $match: this.noteMatch(c, p) }, { $group: { _id: null, n: { $sum: 1 }, totalMinor: { $sum: { $ifNull: ['$totalMinor', 0] } }, netMinor: { $sum: { $ifNull: ['$netMinor', 0] } }, taxMinor: { $sum: { $ifNull: ['$taxMinor', 0] } } } }]);
    const tx = s?.transactions ?? 0;
    return { transactions: tx, grossSalesMinor: s?.totalMinor ?? 0, taxMinor: s?.taxMinor ?? 0, discountMinor: s?.discountMinor ?? 0, returns: rf?.n ?? 0, returnsMinor: rf?.totalMinor ?? 0, returnsNetMinor: rf?.netMinor ?? 0, returnsTaxMinor: rf?.taxMinor ?? 0, averageBasketMinor: tx ? Math.round((s?.totalMinor ?? 0) / tx) : 0 };
  }

  // ── 1 · sales ────────────────────────────────────────────────────────────────
  async sales(req: Req, storeId: string, q: any, t: Tokens) {
    const c = await this.ctx(req, storeId, q, t, 'reports.view');
    const block = async (p: Period) => {
      const tot = await this.saleTotals(c, p);
      const all = (await this.lineAgg(c, p, null)).get('null') ?? zeroLine();
      return { ...tot, netSalesMinor: all.netMinor - tot.returnsNetMinor, netSalesInclTaxMinor: tot.grossSalesMinor - tot.returnsMinor };
    };
    return { success: true, data: { ...this.head(c), totals: await block(c.period), previous: c.previous ? { period: { from: c.previous.from, to: c.previous.to }, totals: await block(c.previous), byDay: await this.daily(c, c.previous) } : null, byDay: await this.daily(c, c.period) } };
  }
  /** One row per store day of [p] (empty days included up to 120 days). */
  private async daily(c: Ctx, p: Period) {
    const rows: any[] = await this.r.saleModel.aggregate([
      { $match: this.saleMatch(c, p) },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: c.tz } }, transactions: { $sum: 1 }, totalMinor: { $sum: { $ifNull: ['$totalMinor', 0] } } } },
      { $sort: { _id: 1 } },
    ]);
    const have = new Map(rows.map((r) => [r._id, { day: r._id, transactions: r.transactions, totalMinor: r.totalMinor }]));
    if (p.days > 120) return [...have.values()];
    const out: any[] = [];
    for (let d = localDay(p.from, c.tz); d.start < p.end; d = localDay(new Date(d.end.getTime() + 3_600_000), c.tz)) out.push(have.get(d.key) ?? { day: d.key, transactions: 0, totalMinor: 0 });
    return out;
  }

  // ── 2 · profit ───────────────────────────────────────────────────────────────
  async profit(req: Req, storeId: string, q: any, t: Tokens) {
    const c = await this.ctx(req, storeId, q, t, 'reports.view');
    const block = async (p: Period) => {
      const sold = (await this.lineAgg(c, p, null)).get('null') ?? zeroLine();
      const back = (await this.returnAgg(c, p, () => 'all')).get('all');
      const x = this.minus(sold, back);
      const expMatch: any = { storeId: c.storeId, occurredAt: { $gte: p.start, $lt: p.end } };
      const expenses: any[] = await this.r.posExpenseModel.find(expMatch).select('_id amountMinor category').lean();
      const rejected = new Set((await this.r.posExpenseEventModel.find({ storeId: c.storeId, expenseId: { $in: expenses.map((e) => String(e._id)) }, type: 'rejected' }).select('expenseId').lean()).map((e: any) => e.expenseId));
      const kept = expenses.filter((e) => !rejected.has(String(e._id)));
      const expensesMinor = kept.reduce((n, e) => n + e.amountMinor, 0);
      const byCat: Record<string, number> = {}; for (const e of kept) byCat[e.category] = (byCat[e.category] ?? 0) + e.amountMinor;
      // shown for transparency ONLY — never subtracted: paying a supplier settles a bill; the goods' cost is already in COGS when they are sold
      const [sp] = await this.r.supplierLedgerEntryModel.aggregate([{ $match: { storeId: c.storeId, type: 'payment', createdAt: { $gte: p.start, $lt: p.end } } }, { $group: { _id: null, t: { $sum: '$amountMinor' } } }]);
      const m = this.margin(x);
      return {
        netSalesMinor: x.netMinor, costOfGoodsSoldMinor: x.costMinor, ...m,
        expensesMinor, expensesByCategoryMinor: byCat, afterExpensesMinor: m.grossMarginMinor - expensesMinor,
        supplierPaymentsMinor: -(sp?.t ?? 0), supplierPaymentsNote: 'Supplier payments are not expenses: the cost of the goods is already counted when they are sold (COGS).',
      };
    };
    return { success: true, data: { ...this.head(c), labels: { grossMargin: 'Gross margin (net sales − cost of goods sold at weighted-average cost)', afterExpenses: 'After expenses (gross margin − recorded expenses; supplier payments excluded)' }, totals: await block(c.period), previous: c.previous ? { period: { from: c.previous.from, to: c.previous.to }, totals: await block(c.previous) } : null } };
  }

  // ── 3 · product / 4 · category ───────────────────────────────────────────────
  async products(req: Req, storeId: string, q: any, t: Tokens) {
    const c = await this.ctx(req, storeId, q, t, 'reports.view');
    const key = { $cond: [{ $eq: ['$items.isCustom', true] }, 'custom', { $ifNull: ['$items.variantId', 'custom'] }] };
    const sold = await this.lineAgg(c, c.period, key);
    const back = await this.returnAgg(c, c.period, (l, _n, sl) => (sl?.isCustom ? 'custom' : String(l.variantId ?? sl?.variantId ?? 'custom')));
    const variantIds = [...sold.keys()].filter((k) => Types.ObjectId.isValid(k));
    const variants: any[] = variantIds.length ? await this.r.productVariantModel.find({ _id: { $in: variantIds } }).select('sku productId options').lean() : [];
    const vMap = new Map(variants.map((v) => [String(v._id), v]));
    const rows = [...sold.entries()].map(([k, a]) => {
      const x = this.minus(a, back.get(k));
      return { variantId: k === 'custom' ? null : k, productId: vMap.get(k)?.productId ?? null, name: k === 'custom' ? 'Custom items' : a.label ?? '', sku: vMap.get(k)?.sku ?? null, qtySold: a.qty, qtyReturned: back.get(k)?.qty ?? 0, netSalesMinor: x.netMinor, costMinor: x.costMinor, ...this.margin(x) };
    });
    const sort = q?.sort === 'qty' ? 'qtySold' : q?.sort === 'margin' ? 'grossMarginMinor' : 'netSalesMinor';
    rows.sort((x: any, y: any) => (y[sort] ?? 0) - (x[sort] ?? 0));
    const limit = Math.min(Math.max(Number(q?.limit) || 50, 1), 500);
    return { success: true, data: { ...this.head(c), products: rows.slice(0, limit), count: rows.length } };
  }
  async categories(req: Req, storeId: string, q: any, t: Tokens) {
    const c = await this.ctx(req, storeId, q, t, 'reports.view');
    const byProduct = await this.lineAgg(c, c.period, { $cond: [{ $eq: ['$items.isCustom', true] }, 'custom', { $ifNull: ['$items.productId', 'custom'] }] });
    const back = await this.returnAgg(c, c.period, (l, _n, sl) => (sl?.isCustom ? 'custom' : String(l.productId ?? sl?.productId ?? 'custom')));
    const pIds = [...byProduct.keys()].filter((k) => Types.ObjectId.isValid(k));
    const products: any[] = pIds.length ? await this.r.productModel.find({ _id: { $in: pIds } }).select('categoryId').lean() : [];
    const catOf = new Map(products.map((p) => [String(p._id), p.categoryId ? String(p.categoryId) : 'uncategorised']));
    const cats = new Map<string, LineAgg>();
    for (const [pid, a] of byProduct) {
      const k = pid === 'custom' ? 'custom' : catOf.get(pid) ?? 'uncategorised';
      const x = this.minus(a, back.get(pid));
      const cur = cats.get(k) ?? zeroLine();
      cats.set(k, { qty: cur.qty + x.qty, grossMinor: cur.grossMinor + x.grossMinor, netMinor: cur.netMinor + x.netMinor, taxMinor: cur.taxMinor + x.taxMinor, discountMinor: cur.discountMinor + x.discountMinor, costMinor: cur.costMinor + x.costMinor, netWithCostMinor: cur.netWithCostMinor + x.netWithCostMinor, netNoCostMinor: cur.netNoCostMinor + x.netNoCostMinor, lines: cur.lines + x.lines });
    }
    const catIds = [...cats.keys()].filter((k) => Types.ObjectId.isValid(k));
    const names: any[] = catIds.length && this.r.categoryModel ? await this.r.categoryModel.find({ _id: { $in: catIds } }).select('name').lean() : [];
    const nm = new Map(names.map((x) => [String(x._id), x.name]));
    const rows = [...cats.entries()].map(([k, x]) => ({ categoryId: Types.ObjectId.isValid(k) ? k : null, name: k === 'custom' ? 'Custom items' : k === 'uncategorised' ? 'Uncategorised' : nm.get(k) ?? 'Category', qty: x.qty, netSalesMinor: x.netMinor, costMinor: x.costMinor, ...this.margin(x) })).sort((a, b) => b.netSalesMinor - a.netSalesMinor);
    return { success: true, data: { ...this.head(c), categories: rows } };
  }

  // ── 5 · tax ──────────────────────────────────────────────────────────────────
  /** By tax category and HS code; sales lines minus return credit-note lines. The totals equal Σ invoices − Σ credit notes of the period (tested). */
  async tax(req: Req, storeId: string, q: any, t: Tokens) {
    const c = await this.ctx(req, storeId, q, t, 'reports.view');
    const sold = await this.lineAgg(c, c.period, { $concat: [{ $ifNull: ['$items.taxCategory', 'standard'] }, '|', { $ifNull: ['$items.hsCode', ''] }] });
    const notes: any[] = await this.r.posCreditNoteModel.find(this.noteMatch(c, c.period)).select('lines').lean();
    const back = new Map<string, { net: number; tax: number }>();
    for (const n of notes) for (const l of n.lines ?? []) { const k = `${l.taxCategory ?? 'standard'}|${l.hsCode ?? ''}`; const x = back.get(k) ?? { net: 0, tax: 0 }; x.net += l.netMinor ?? 0; x.tax += l.taxMinor ?? 0; back.set(k, x); }
    const rows = [...new Set([...sold.keys(), ...back.keys()])].map((k) => {
      const [cat, hs] = k.split('|'); const s2 = sold.get(k); const b2 = back.get(k);
      return { taxCategory: cat || 'standard', hsCode: hs || null, salesNetMinor: s2?.netMinor ?? 0, salesTaxMinor: s2?.taxMinor ?? 0, returnsNetMinor: b2?.net ?? 0, returnsTaxMinor: b2?.tax ?? 0, netMinor: (s2?.netMinor ?? 0) - (b2?.net ?? 0), taxMinor: (s2?.taxMinor ?? 0) - (b2?.tax ?? 0) };
    }).sort((x, y) => y.taxMinor - x.taxMinor);
    const tot = await this.saleTotals(c, c.period);
    return { success: true, data: { ...this.head(c), rows, totals: { salesTaxMinor: rows.reduce((n, r) => n + r.salesTaxMinor, 0), returnsTaxMinor: rows.reduce((n, r) => n + r.returnsTaxMinor, 0), netTaxMinor: rows.reduce((n, r) => n + r.taxMinor, 0), invoices: tot.transactions, creditNotes: tot.returns, invoiceTaxMinor: tot.taxMinor, creditNoteTaxMinor: tot.returnsTaxMinor } } };
  }

  // ── 6 · payment mix ──────────────────────────────────────────────────────────
  async payments(req: Req, storeId: string, q: any, t: Tokens) {
    const c = await this.ctx(req, storeId, q, t, 'reports.view');
    const paid: any[] = await this.r.saleModel.aggregate([
      { $match: this.saleMatch(c, c.period) },
      { $project: { payments: { $cond: [{ $gt: [{ $size: { $ifNull: ['$payments', []] } }, 0] }, '$payments', [{ method: '$paymentMethod', amountMinor: '$totalMinor' }]] } } },
      { $unwind: '$payments' },
      { $group: { _id: '$payments.method', amountMinor: { $sum: { $ifNull: ['$payments.amountMinor', 0] } }, count: { $sum: 1 } } },
    ]);
    const rm: any = { storeId: c.storeId, createdAt: { $gte: c.period.start, $lt: c.period.end } };
    if (c.filters.registerId) rm.registerId = c.filters.registerId;
    if (c.filters.employeeId) rm.employeeId = c.filters.employeeId;
    const refunded: any[] = await this.r.posRefundModel.aggregate([{ $match: rm }, { $unwind: '$tenders' }, { $group: { _id: '$tenders.method', amountMinor: { $sum: { $ifNull: ['$tenders.amountMinor', 0] } } } }]);
    const methods = new Set([...paid.map((x) => x._id), ...refunded.map((x) => x._id)].filter(Boolean));
    const rows = [...methods].map((mth) => { const p = paid.find((x) => x._id === mth); const rf = refunded.find((x) => x._id === mth); return { method: mth, payments: p?.count ?? 0, paidMinor: p?.amountMinor ?? 0, refundedMinor: rf?.amountMinor ?? 0, netMinor: (p?.amountMinor ?? 0) - (rf?.amountMinor ?? 0) }; }).sort((a, b) => b.netMinor - a.netMinor);
    const total = rows.reduce((n, r) => n + r.netMinor, 0);
    // G5.4 (additive): the card taken on a separate bank terminal, as its own line (it is also inside `card` above, so older clients are unchanged)
    const [xp] = await this.r.saleModel.aggregate([{ $match: this.saleMatch(c, c.period) }, { $unwind: '$payments' }, { $match: { 'payments.method': 'card', 'payments.terminal.approvalCode': { $type: 'string' } } }, { $group: { _id: null, n: { $sum: 1 }, m: { $sum: { $ifNull: ['$payments.amountMinor', 0] } } } }]);
    const [xr] = await this.r.posRefundModel.aggregate([{ $match: rm }, { $unwind: '$tenders' }, { $match: { 'tenders.method': 'card', 'tenders.externalTerminal': true } }, { $group: { _id: null, m: { $sum: { $ifNull: ['$tenders.amountMinor', 0] } } } }]);
    const cardExternalTerminal = { payments: xp?.n ?? 0, paidMinor: xp?.m ?? 0, refundedMinor: xr?.m ?? 0, netMinor: (xp?.m ?? 0) - (xr?.m ?? 0) };
    return { success: true, data: { ...this.head(c), methods: rows.map((r) => ({ ...r, sharePercent: total ? Math.round((r.netMinor / total) * 1000) / 10 : 0 })), netMinor: total, cardExternalTerminal } };
  }

  // ── 7 · cashier (+ staff stats) ───────────────────────────────────────────────
  /** Per employee. A cashier asking gets only themself (owner decision 3). */
  async cashiers(req: Req, storeId: string, q: any, t: Tokens) {
    const c = await this.ctx(req, storeId, q, t, 'reports.cashier.own');
    if (c.role === 'cashier') { if (!c.employeeId) throw new ForbiddenException({ statusCode: 403, code: 'POS_ACTION_FORBIDDEN', message: 'Sign in with your PIN' }); c.filters.employeeId = c.employeeId; }
    else if (c.role !== 'owner') { /* managers: everyone */ }
    const sold = await this.lineAgg(c, c.period, '$employeeId');
    const counts: any[] = await this.r.saleModel.aggregate([{ $match: this.saleMatch(c, c.period) }, { $group: { _id: '$employeeId', transactions: { $sum: 1 }, totalMinor: { $sum: { $ifNull: ['$totalMinor', 0] } }, discountMinor: { $sum: { $ifNull: ['$discountMinor', 0] } } } }]);
    const back = await this.returnAgg(c, c.period, (_l, n) => String(n.employeeId ?? 'unknown'));
    const vm: any = { storeId: c.storeId, kind: 'void', createdAt: { $gte: c.period.start, $lt: c.period.end } };
    if (c.filters.employeeId) vm.employeeId = c.filters.employeeId;
    const voids: any[] = await this.r.posCreditNoteModel.aggregate([{ $match: vm }, { $group: { _id: '$employeeId', n: { $sum: 1 }, totalMinor: { $sum: '$totalMinor' } } }]);
    const ids = [...new Set([...sold.keys(), ...back.keys(), ...voids.map((v) => String(v._id))])].filter((k) => k && k !== 'null' && k !== 'unknown');
    // hours worked in the period from G3.6 attendance (closed records only)
    const worked = new Map<string, number>();
    if (this.r.posAttendanceEventModel) {
      const evs: any[] = await this.r.posAttendanceEventModel.find({ storeId: c.storeId, at: { $gte: new Date(c.period.start.getTime() - 86_400_000), $lt: new Date(c.period.end.getTime() + 86_400_000) }, ...(c.filters.employeeId ? { employeeId: c.filters.employeeId } : {}) }).sort({ at: 1 }).lean();
      const byEmp = new Map<string, any[]>(); for (const e of evs) { const l = byEmp.get(e.employeeId) ?? []; l.push({ id: String(e._id), type: e.type, at: e.at, serverAt: e.serverAt, recordId: e.recordId, flags: e.flags, correction: e.correction }); byEmp.set(e.employeeId, l); }
      for (const [id, l] of byEmp) worked.set(id, deriveRecords(l).records.filter((x) => x.status !== 'voided' && x.clockInAt >= c.period.start && x.clockInAt < c.period.end).reduce((n, x) => n + x.workedMinutes, 0));
      for (const id of byEmp.keys()) if (!ids.includes(id)) ids.push(id);
    }
    const emps: any[] = ids.filter((x) => Types.ObjectId.isValid(x)).length ? await this.r.employeeModel.find({ _id: { $in: ids.filter((x) => Types.ObjectId.isValid(x)) }, storeId: c.storeId }).select('name role lastLoginAt').lean() : [];
    const em = new Map(emps.map((e) => [String(e._id), e]));
    const rows = ids.map((id) => {
      const s = sold.get(id) ?? zeroLine(); const cnt = counts.find((x) => String(x._id) === id); const b = back.get(id); const v = voids.find((x) => String(x._id) === id);
      return { employeeId: id, name: em.get(id)?.name ?? 'Team member', role: em.get(id)?.role ?? null, lastLoginAt: em.get(id)?.lastLoginAt ?? null, transactions: cnt?.transactions ?? 0, salesMinor: cnt?.totalMinor ?? 0, netSalesMinor: s.netMinor, averageBasketMinor: cnt?.transactions ? Math.round(cnt.totalMinor / cnt.transactions) : 0, discountsMinor: cnt?.discountMinor ?? 0, returnsProcessed: b?.lines ?? 0, returnsNetMinor: b?.netMinor ?? 0, voids: v?.n ?? 0, voidsMinor: v?.totalMinor ?? 0, workedMinutes: worked.get(id) ?? 0 };
    }).sort((a, b) => b.netSalesMinor - a.netSalesMinor);
    return { success: true, data: { ...this.head(c), ownOnly: c.role === 'cashier', cashiers: rows } };
  }

  // ── 8 · hourly ───────────────────────────────────────────────────────────────
  async hourly(req: Req, storeId: string, q: any, t: Tokens) {
    const c = await this.ctx(req, storeId, q, t, 'reports.view');
    const rows: any[] = await this.r.saleModel.aggregate([
      { $match: this.saleMatch(c, c.period) },
      { $group: { _id: { h: { $hour: { date: '$createdAt', timezone: c.tz } }, d: { $isoDayOfWeek: { date: '$createdAt', timezone: c.tz } } }, transactions: { $sum: 1 }, totalMinor: { $sum: { $ifNull: ['$totalMinor', 0] } } } },
    ]);
    const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, transactions: 0, totalMinor: 0 }));
    const heat = Array.from({ length: 7 }, (_, d) => ({ isoWeekday: d + 1, hours: Array.from({ length: 24 }, () => 0) }));
    for (const x of rows) { byHour[x._id.h].transactions += x.transactions; byHour[x._id.h].totalMinor += x.totalMinor; heat[x._id.d - 1].hours[x._id.h] += x.totalMinor; }
    const busiest = [...byHour].sort((a, b) => b.totalMinor - a.totalMinor)[0];
    return { success: true, data: { ...this.head(c), byHour, weekdayHourMinor: heat, busiestHour: busiest.totalMinor > 0 ? busiest.hour : null } };
  }

  // ── business pulse (G4.0) ────────────────────────────────────────────────────
  /** Today so far vs the same weekday last week (up to the same time of day), in the store's time zone. */
  async pulse(req: Req, storeId: string, q: any, t: Tokens) {
    const c = await this.ctx(req, storeId, { from: q?.date, to: q?.date }, t, 'reports.view');
    const now = new Date();
    const today = c.period;
    const lastWeek = localDay(new Date(today.start.getTime() + 12 * 3_600_000 - 7 * 86_400_000), c.tz);
    const isToday = now >= today.start && now < today.end;
    const elapsed = isToday ? now.getTime() - today.start.getTime() : today.end.getTime() - today.start.getTime();
    const p1: Period = { ...today, end: isToday ? now : today.end };
    const p0: Period = { from: lastWeek.key, to: lastWeek.key, start: lastWeek.start, end: new Date(Math.min(lastWeek.start.getTime() + elapsed, lastWeek.end.getTime())), days: 1 };
    const fig = async (p: Period) => {
      const tot = await this.saleTotals(c, p);
      const sold = (await this.lineAgg(c, p, null)).get('null') ?? zeroLine();
      const back = (await this.returnAgg(c, p, () => 'all')).get('all');
      const x = this.minus(sold, back);
      const pay: any[] = await this.r.saleModel.aggregate([{ $match: this.saleMatch(c, p) }, { $unwind: { path: '$payments', preserveNullAndEmptyArrays: false } }, { $group: { _id: '$payments.method', a: { $sum: { $ifNull: ['$payments.amountMinor', 0] } } } }]);
      const ex: any[] = await this.r.posExpenseModel.aggregate([{ $match: { storeId: c.storeId, occurredAt: { $gte: p.start, $lt: p.end } } }, { $group: { _id: null, a: { $sum: '$amountMinor' } } }]);
      return { netSalesMinor: x.netMinor, transactions: tot.transactions, averageBasketMinor: tot.averageBasketMinor, grossMarginMinor: this.margin(x).grossMarginMinor, cashMinor: pay.find((y) => y._id === 'cash')?.a ?? 0, cardMinor: pay.find((y) => y._id === 'card')?.a ?? 0, returnsMinor: tot.returnsMinor, expensesMinor: ex[0]?.a ?? 0 };
    };
    const [now1, then0] = [await fig(p1), await fig(p0)];
    const change = (a: number, b: number) => (b ? Math.round(((a - b) / Math.abs(b)) * 1000) / 10 : null);
    const top: any[] = [...(await this.lineAgg(c, p1, { $ifNull: ['$items.variantId', 'custom'] })).entries()].map(([k, v]) => ({ variantId: k === 'custom' ? null : k, name: v.label ?? '', qty: v.qty, netSalesMinor: v.netMinor })).sort((a, b) => b.netSalesMinor - a.netSalesMinor).slice(0, 5);
    const lowStock = await this.r.productVariantModel.countDocuments({ storeId: c.storeId, isDelete: false, unlimitedStock: { $ne: true }, $expr: { $lte: ['$stock', { $ifNull: ['$reorderPoint', 0] }] }, reorderPoint: { $gt: 0 } });
    const clockedIn = this.r.posAttendanceStateModel ? await this.r.posAttendanceStateModel.countDocuments({ storeId: c.storeId, openRecordId: { $ne: null } }) : 0;
    return { success: true, data: { ...this.head(c), asOf: p1.end, comparedWith: { day: lastWeek.key, upTo: p0.end }, today: now1, sameDayLastWeek: then0, changePercent: Object.fromEntries(Object.keys(now1).map((k) => [k, change((now1 as any)[k], (then0 as any)[k])])), topProducts: top, lowStockCount: lowStock, clockedInNow: clockedIn } };
  }

  // ── store time zone (G4.0) ────────────────────────────────────────────────────
  async timeZone(req: Req, storeId: string) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    const st: any = await this.r.storeModel.findById(storeId).select('timezone country').lean();
    const tz = await this.pos.storeTz(storeId);
    return { success: true, data: { timeZone: tz, explicit: !!st?.timezone, country: st?.country ?? null, today: localDay(undefined, tz).key } };
  }
  /** Owner only. The store's zone is shared with the storefront analytics (one store, one clock). Audited with before / after. */
  async setTimeZone(req: Req, storeId: string, body: any, t: Tokens) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    const a = await this.auth.authorize(req, { storeId, action: 'settings.store.edit', employeeToken: t.employee });
    const tz = typeof body?.timeZone === 'string' ? body.timeZone.trim() : '';
    if (!isValidTimeZone(tz)) throw bad('INVALID_TIME_ZONE', 'Choose a valid time zone (for example Asia/Karachi)');
    const before = await this.pos.storeTz(storeId);
    await this.r.storeModel.updateOne({ _id: storeId }, { $set: { timezone: tz } });
    await this.r.posAuditLogModel.create([{ storeId, employeeId: a.employeeId, action: 'store_time_zone_changed', targetId: storeId, targetType: 'store', metadata: { before, after: tz } }]);
    return this.timeZone(req, storeId);
  }
}
