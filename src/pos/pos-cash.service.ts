/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClientSession, Types } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { fromMinor, isoExponent, isSafeMinor, toMinor } from '@/common/money-minor.util';
import { UploadService } from '../upload/upload.service';
import { detectKybMime } from '../kyb/kyb-validators';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosAction } from './pos-permissions.config';
import { recordCashMovement } from './pos-cash-out.util';
import { tenderNets } from './pos-money.util';
import { EXPENSE_CATEGORIES, EXPENSE_METHODS } from './schemas/pos-expense.schema';

type Req = any;
interface Tokens { employee?: string; approver?: string }
const err = (status: 400 | 403 | 404 | 409, code: string, message: string, extra: object = {}) => {
  const body = { statusCode: status, code, message, ...extra };
  return status === 404 ? new NotFoundException(body) : status === 409 ? new ConflictException(body) : status === 403 ? new ForbiddenException(body) : new BadRequestException(body);
};
const str = (v: any, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const minorOf = (v: any, field = 'amountMinor'): number => {
  if (!isSafeMinor(v) || v <= 0) throw err(400, 'INVALID_AMOUNT', `${field} must be a whole number of minor units above 0`);
  return v;
};
const dateOf = (v: any, field: string): Date | null => {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw err(400, 'INVALID_DATE', `${field} is not a valid date`);
  return d;
};

/** Why cash moved by hand. `supplier_payment` and `expense` are written by their own flows, never typed in. */
export const CASH_IN_CATEGORIES = ['float_topup', 'owner_injection', 'other_in'] as const;
export const CASH_OUT_CATEGORIES = ['bank_deposit', 'safe_drop', 'petty', 'owner_draw', 'other_out'] as const;
const NOTE_REQUIRED = new Set(['other_in', 'other_out']);
const receiptMaxBytes = () => { const n = Number(process.env.EXPENSE_RECEIPT_MAX_BYTES); return Number.isFinite(n) && n >= 1024 ? Math.floor(n) : 5 * 1024 * 1024; };

/**
 * G3.5 — cash in / out, expenses (with a private receipt photo) and the daybook. All money is integer minor units and every response states its currency + exponent.
 * A cash movement is a row on the open shift (the same row G3.4 supplier payments use), so the shift's expected cash and the daybook can never disagree.
 */
@Injectable()
export class PosCashService {
  constructor(
    private readonly db: DatabaseService,
    private readonly pos: PosService,
    private readonly auth: PosAuthorizer,
    private readonly upload: UploadService,
  ) {}
  private get r(): any { return this.db.repositories; }

  private async gate(req: Req, storeId: string, action: PosAction, t: Tokens, ctx?: Parameters<PosAuthorizer['authorize']>[1]['ctx']) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    return this.auth.authorize(req, { storeId, action, ctx, employeeToken: t.employee, approverToken: t.approver });
  }
  private async cur(storeId: string): Promise<{ currency: string; currencyExponent: number }> {
    const s: any = await this.r.storeModel.findById(storeId).select('baseCurrency').lean();
    const currency = String(s?.baseCurrency || 'USD').toUpperCase();
    return { currency, currencyExponent: isoExponent(currency) };
  }
  private audit(storeId: string, employeeId: string | null, action: string, targetId: string | null, metadata: object, tx?: ClientSession) {
    return this.r.posAuditLogModel.create([{ storeId, employeeId, action, targetId, targetType: 'cash', metadata }], tx ? { session: tx } : undefined);
  }
  private deviceOf = (req: Req): string | null => req?.user?.posDevice?.deviceId ?? null;
  private atomic<T>(fn: (tx: ClientSession) => Promise<T>): Promise<T> { return this.r.registerSessionModel.db.transaction(fn); }
  private async ensureSettings(storeId: string) { await this.r.posSettingsModel.updateOne({ storeId }, { $setOnInsert: { storeId } }, { upsert: true }); }

  async config(req: Req, storeId: string, t: Tokens) {
    await this.gate(req, storeId, 'cash.in', t);
    const limits = await this.auth.limitsFor(storeId);
    return { success: true, data: { ...(await this.cur(storeId)), cashInCategories: CASH_IN_CATEGORIES, cashOutCategories: CASH_OUT_CATEGORIES, expenseCategories: EXPENSE_CATEGORIES, expenseMethods: EXPENSE_METHODS, noteRequiredFor: [...NOTE_REQUIRED], cashOutApprovalAboveMinor: limits.cashOutMinor, expenseApprovalAboveMinor: limits.expenseMinor } };
  }

  // ── cash in / out ─────────────────────────────────────────────────────────────
  /**
   * A cash movement on the OPEN shift: float top-up, bank deposit, safe drop, petty cash, owner draw … Above the store's limit (D6) a manager's PIN approves.
   * `requestId` makes a retry / an offline replay a no-op; `occurredAt` keeps the device's time. A closed shift refuses it (409 NO_OPEN_SHIFT) — an offline movement that
   * arrives after its shift closed is a conflict the app puts under Needs attention, never silently booked into a closed count.
   */
  async move(req: Req, storeId: string, body: any, t: Tokens) {
    const type = body?.type === 'cash_in' ? 'cash_in' : body?.type === 'cash_out' ? 'cash_out' : null;
    if (!type) throw err(400, 'INVALID_TYPE', 'type must be cash_in or cash_out');
    const category = String(body?.category ?? '');
    if (!((type === 'cash_in' ? CASH_IN_CATEGORIES : CASH_OUT_CATEGORIES) as readonly string[]).includes(category)) throw err(400, 'INVALID_CATEGORY', 'Choose a reason for this cash movement');
    const amountMinor = minorOf(body?.amountMinor);
    const note = str(body?.note, 300);
    if (NOTE_REQUIRED.has(category) && !note) throw err(400, 'NOTE_REQUIRED', 'Add a note for "other"');
    const requestId = str(body?.requestId, 100);
    if (!requestId) throw err(400, 'REQUEST_ID_REQUIRED', 'A cash movement needs a requestId so a retry cannot book it twice');
    const sessionId = str(body?.sessionId, 40);
    if (!sessionId || !Types.ObjectId.isValid(sessionId)) throw err(409, 'NO_OPEN_SHIFT', 'This needs an open shift on this till.');
    const occurredAt = dateOf(body?.occurredAt, 'occurredAt');
    if (occurredAt && occurredAt.getTime() > Date.now() + 5 * 60_000) throw err(400, 'INVALID_DATE', 'occurredAt is in the future');
    const a = await this.gate(req, storeId, type === 'cash_in' ? 'cash.in' : 'cash.out', t, { amountMinor });
    const { currency, currencyExponent: exp } = await this.cur(storeId);
    const by = a.approvedBy?.employeeId ?? null;
    const label = `${type === 'cash_in' ? 'Cash in' : 'Cash out'} — ${category.replace(/_/g, ' ')}${note ? `: ${note}` : ''}`;
    const result = await this.atomic(async (tx) => {
      const r = await recordCashMovement(this.r.registerSessionModel, tx, { storeId, sessionId, amountMinor, exp, reason: label, employeeId: a.employeeId ?? 'owner', category, refType: 'cash_movement', refId: requestId, type, requestId, occurredAt, approvedBy: by, note });
      if (r === 'applied') await this.audit(storeId, a.employeeId, type, sessionId, { category, amountMinor, requestId, approvedBy: by, occurredAt, note }, tx);
      return r;
    });
    return { success: true, data: { currency, currencyExponent: exp, duplicate: result === 'duplicate', movement: { type, category, amountMinor, sessionId, requestId, note, occurredAt } } };
  }

  // ── expenses ──────────────────────────────────────────────────────────────────
  private async statusOf(storeId: string, ids: string[]): Promise<Map<string, { status: string; note: string | null; hasReceipt: boolean; decidedBy: string | null }>> {
    const out = new Map<string, any>(ids.map((i) => [i, { status: 'recorded', note: null, hasReceipt: false, decidedBy: null }]));
    if (!ids.length) return out;
    const ev: any[] = await this.r.posExpenseEventModel.find({ storeId, expenseId: { $in: ids } }).sort({ createdAt: 1, _id: 1 }).lean();
    for (const e of ev) {
      const o = out.get(e.expenseId); if (!o) continue;
      if (e.type === 'receipt_attached') o.hasReceipt = true;
      else { o.status = e.type; o.note = e.note ?? null; o.decidedBy = e.employeeId ?? null; }
    }
    return out;
  }
  private expenseView(x: any, st: { status: string; note: string | null; hasReceipt: boolean; decidedBy: string | null } | undefined) {
    return { id: String(x._id), number: x.number, category: x.category, amountMinor: x.amountMinor, currency: x.currency, currencyExponent: x.currencyExponent, payee: x.payee ?? null, method: x.method, note: x.note ?? null, occurredAt: x.occurredAt, sessionId: x.sessionId ?? null, employeeId: x.employeeId ?? null, approvedBy: x.approvedBy ?? null, createdAt: x.createdAt ?? null, status: st?.status ?? 'recorded', decisionNote: st?.note ?? null, hasReceipt: st?.hasReceipt ?? false };
  }

  /** Record an expense. A drawer expense takes the money out of the open shift in the SAME transaction (and needs that shift); bank / other are recorded only. */
  async expense(req: Req, storeId: string, body: any, t: Tokens) {
    const category = String(body?.category ?? '');
    if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category)) throw err(400, 'INVALID_CATEGORY', 'Choose an expense category');
    const method = String(body?.method ?? '');
    if (!(EXPENSE_METHODS as readonly string[]).includes(method)) throw err(400, 'INVALID_METHOD', 'Choose how it was paid: cash, bank or other');
    const amountMinor = minorOf(body?.amountMinor);
    const requestId = str(body?.requestId, 100);
    if (!requestId) throw err(400, 'REQUEST_ID_REQUIRED', 'An expense needs a requestId so a retry cannot record it twice');
    const payee = str(body?.payee, 120); const note = str(body?.note, 300);
    if (category === 'other' && !note) throw err(400, 'NOTE_REQUIRED', 'Add a note for "other"');
    const occurredAt = dateOf(body?.occurredAt, 'occurredAt') ?? new Date();
    if (occurredAt.getTime() > Date.now() + 5 * 60_000) throw err(400, 'INVALID_DATE', 'occurredAt is in the future');
    const sessionId = str(body?.sessionId, 40);
    if (method === 'cash' && (!sessionId || !Types.ObjectId.isValid(sessionId))) throw err(409, 'NO_OPEN_SHIFT', 'Paying an expense from the drawer needs an open shift.');
    const a = await this.gate(req, storeId, 'expenses.record', t, { amountMinor });
    const { currency, currencyExponent: exp } = await this.cur(storeId);
    const existing: any = await this.r.posExpenseModel.findOne({ storeId, requestId }).lean();
    const view = async (x: any, duplicate: boolean) => ({ success: true, data: { currency, currencyExponent: exp, duplicate, expense: this.expenseView(x, (await this.statusOf(storeId, [String(x._id)])).get(String(x._id))) } });
    if (existing) return view(existing, true);
    await this.ensureSettings(storeId);
    const by = a.approvedBy?.employeeId ?? null;
    let doc: any;
    try {
      doc = await this.atomic(async (tx) => {
        const s: any = await this.r.posSettingsModel.findOneAndUpdate({ storeId }, { $inc: { expenseCounter: 1 } }, { new: true, upsert: true, session: tx });
        const seq = Number(s.expenseCounter);
        const [e] = await this.r.posExpenseModel.create([{
          storeId, number: `EXP-${String(seq).padStart(6, '0')}`, seq, category, amountMinor, currency, currencyExponent: exp, payee, method, note, occurredAt,
          sessionId: method === 'cash' ? sessionId : null, employeeId: a.employeeId, approvedBy: by, deviceId: this.deviceOf(req), requestId,
        }], { session: tx });
        if (method === 'cash') {
          await recordCashMovement(this.r.registerSessionModel, tx, { storeId, sessionId: sessionId!, amountMinor, exp, reason: `Expense ${e.number} — ${category.replace(/_/g, ' ')}${payee ? ` (${payee})` : ''}`, employeeId: a.employeeId ?? 'owner', category: 'expense', refType: 'expense', refId: String(e._id), type: 'cash_out', requestId: `exp:${requestId}`, occurredAt, approvedBy: by, note });
        }
        await this.audit(storeId, a.employeeId, 'expense_recorded', String(e._id), { number: e.number, category, amountMinor, method, sessionId, approvedBy: by }, tx);
        return e;
      });
    } catch (e: any) {
      if (e?.code === 11000) { const dup: any = await this.r.posExpenseModel.findOne({ storeId, requestId }).lean(); if (dup) return view(dup, true); }
      throw e;
    }
    return view(doc.toObject(), false);
  }

  private async mayTouch(a: { role: string; employeeId: string | null }, x: any) {
    if (a.role !== 'cashier') return;
    if (!a.employeeId || x.employeeId !== a.employeeId) throw err(403, 'POS_ACTION_FORBIDDEN', 'A cashier can only see their own expenses');
  }
  private async loadExpense(storeId: string, id: string): Promise<any> {
    if (!Types.ObjectId.isValid(id)) throw err(404, 'EXPENSE_NOT_FOUND', 'Expense not found');
    const x: any = await this.r.posExpenseModel.findOne({ _id: id, storeId }).lean();
    if (!x) throw err(404, 'EXPENSE_NOT_FOUND', 'Expense not found');
    return x;
  }

  async expenses(req: Req, storeId: string, q: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'expenses.record', t);
    const filter: any = { storeId };
    if (a.role === 'cashier') filter.employeeId = a.employeeId;
    const from = dateOf(q?.from, 'from'); const to = dateOf(q?.to, 'to');
    if (from || to) filter.occurredAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
    const rows: any[] = await this.r.posExpenseModel.find(filter).sort({ occurredAt: -1, _id: -1 }).limit(Math.min(Number(q?.limit) || 100, 300)).lean();
    const st = await this.statusOf(storeId, rows.map((x) => String(x._id)));
    let list = rows.map((x) => this.expenseView(x, st.get(String(x._id))));
    if (q?.status && q.status !== 'all') list = list.filter((x) => x.status === q.status);
    const byCat: Record<string, number> = {};
    for (const x of list) if (x.status !== 'rejected') byCat[x.category] = (byCat[x.category] ?? 0) + x.amountMinor;
    return { success: true, data: { ...(await this.cur(storeId)), expenses: list, totalsByCategoryMinor: byCat } };
  }
  async expenseGet(req: Req, storeId: string, id: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'expenses.record', t);
    const x = await this.loadExpense(storeId, id);
    await this.mayTouch(a, x);
    const st = (await this.statusOf(storeId, [id])).get(id);
    return { success: true, data: { ...(await this.cur(storeId)), expense: this.expenseView(x, st) } };
  }
  /** A manager approves or rejects an expense after the fact (a rejection needs a reason). It never moves cash: the money already left the drawer — a rejection flags it for follow-up. */
  async expenseDecide(req: Req, storeId: string, id: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'expenses.approve', t);
    const decision = body?.decision === 'approve' ? 'approved' : body?.decision === 'reject' ? 'rejected' : null;
    if (!decision) throw err(400, 'INVALID_DECISION', 'decision must be approve or reject');
    const note = str(body?.note, 300);
    if (decision === 'rejected' && !note) throw err(400, 'NOTE_REQUIRED', 'Say why it is rejected');
    const x = await this.loadExpense(storeId, id);
    const cur = (await this.statusOf(storeId, [id])).get(id)!;
    if (cur.status !== 'recorded') throw err(409, 'ALREADY_DECIDED', `This expense was already ${cur.status}.`);
    await this.r.posExpenseEventModel.create([{ storeId, expenseId: id, type: decision, note, employeeId: a.employeeId, deviceId: this.deviceOf(req) }]);
    await this.audit(storeId, a.employeeId, `expense_${decision}`, id, { number: x.number, note });
    return this.expenseGet(req, storeId, id, t);
  }

  // ── receipt photo: private, magic-byte checked, expiring links ────────────────
  async receiptUpload(req: Req, storeId: string, id: string, file: Express.Multer.File | undefined, t: Tokens) {
    const a = await this.gate(req, storeId, 'expenses.record', t);
    const x = await this.loadExpense(storeId, id);
    await this.mayTouch(a, x);
    if (!file?.buffer) throw err(400, 'FILE_REQUIRED', 'A photo or PDF is required');
    if (file.size > receiptMaxBytes()) throw err(400, 'FILE_TOO_LARGE', `Receipts can be at most ${Math.round(receiptMaxBytes() / 1024 / 1024 * 10) / 10} MB`, { maxBytes: receiptMaxBytes() });
    const mime = detectKybMime(file.buffer); // by CONTENT, never by the name or the client's Content-Type
    if (!mime) throw err(400, 'FILE_TYPE', 'Only JPEG, PNG or PDF files are accepted');
    const up = await this.upload.uploadPrivateFile({ ...file, mimetype: mime, originalname: `receipt-${x.number}` } as Express.Multer.File, `private/expense-receipts/${storeId}`);
    try {
      await this.r.posExpenseEventModel.create([{ storeId, expenseId: id, type: 'receipt_attached', receipt: { publicId: up.publicId, resourceType: up.resourceType, mimeType: mime, fileSize: file.size }, employeeId: a.employeeId, deviceId: this.deviceOf(req) }]);
    } catch (e) { await this.upload.deletePrivateFile(up.publicId, up.resourceType).catch(() => undefined); throw e; }
    await this.audit(storeId, a.employeeId, 'expense_receipt_attached', id, { number: x.number, mimeType: mime, fileSize: file.size });
    return this.expenseGet(req, storeId, id, t);
  }
  /** A link that works for at most 5 minutes (Cloudinary enforces it); never logged, never cached on the device (the route answers `Cache-Control: no-store`). Managers and the person who recorded it. */
  async receiptLink(req: Req, storeId: string, id: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'expenses.record', t);
    const x = await this.loadExpense(storeId, id);
    await this.mayTouch(a, x);
    const ev: any = await this.r.posExpenseEventModel.findOne({ storeId, expenseId: id, type: 'receipt_attached' }).sort({ createdAt: -1, _id: -1 }).lean();
    if (!ev?.receipt) throw err(404, 'NO_RECEIPT', 'This expense has no receipt photo');
    await this.audit(storeId, a.employeeId, 'expense_receipt_viewed', id, { number: x.number });
    return { success: true, data: { url: this.upload.generateExpiringPrivateUrl(ev.receipt.publicId, ev.receipt.resourceType, 300, { inline: true }), expiresInSeconds: 300, mimeType: ev.receipt.mimeType } };
  }

  // ── daybook ───────────────────────────────────────────────────────────────────
  /**
   * One chronological ledger per shift for a day (shifts that OPENED between `from` and `to`), every line the drawer saw: opening float, cash sales, cash refunds / voids (on the
   * shift that PAID them — G3.0), cash in, cash out, expenses, supplier payments, then the closing count and variance. The running balance is the drawer's expected cash; it must equal
   * the shift's own close figure (`reconciled`). A mismatch is shown as an explicit `unreconciled` difference, never hidden. Cashiers see only shifts they opened.
   */
  async daybook(req: Req, storeId: string, q: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'daybook.view', t);
    const { currency, currencyExponent: exp } = await this.cur(storeId);
    const from = dateOf(q?.from, 'from'); const to = dateOf(q?.to, 'to');
    if (!from || !to || to <= from) throw err(400, 'RANGE_REQUIRED', 'Send from and to (ISO times) for the day');
    if (to.getTime() - from.getTime() > 32 * 86_400_000) throw err(400, 'RANGE_TOO_LONG', 'A daybook covers at most 31 days');
    const filter: any = { storeId, openedAt: { $gte: from, $lt: to } };
    if (q?.registerId) filter.registerId = String(q.registerId);
    if (a.role === 'cashier') filter.employeeId = a.employeeId;
    const sessions: any[] = await this.r.registerSessionModel.find(filter).sort({ openedAt: 1 }).lean();
    const store: any = await this.r.storeModel.findById(storeId).select('registers').lean();
    const regName = new Map<string, string>((store?.registers ?? []).map((g: any) => [String(g._id), g.name]));
    const empIds = [...new Set(sessions.map((s) => s.employeeId).filter(Boolean))];
    const emps: any[] = empIds.length ? await this.r.employeeModel.find({ _id: { $in: empIds } }).select('name').lean() : [];
    const empName = new Map(emps.map((e) => [String(e._id), e.name]));
    const shifts: any[] = [];
    const totals = { cashSalesMinor: 0, cashRefundsMinor: 0, cashInMinor: 0, cashOutMinor: 0, expensesMinor: 0, supplierPaymentsMinor: 0, varianceMinor: 0 };
    for (const s of sessions) {
      const sid = String(s._id);
      const lines: { at: Date; sort: number; type: string; label: string; refType: string | null; refId: string | null; amountMinor: number; employeeId: string | null }[] = [];
      const openingMinor = s.openingCashMinor ?? toMinor(s.openingCash ?? 0, exp);
      lines.push({ at: s.openedAt, sort: 0, type: 'opening', label: 'Opening float', refType: 'session', refId: sid, amountMinor: openingMinor, employeeId: s.employeeId ?? null });
      const sales: any[] = await this.r.saleModel.find({ storeId, sessionId: sid, status: { $in: ['completed', 'partially_refunded', 'refunded', 'voided'] } }).sort({ createdAt: 1 }).lean();
      for (const sl of sales) {
        const cash = toMinor(tenderNets({ ...sl, refundedAmount: 0, status: 'completed' } as any, exp).cash, exp);
        if (cash !== 0) lines.push({ at: sl.createdAt, sort: 1, type: 'cash_sale', label: `Sale ${sl.saleNumber ?? ''}`.trim(), refType: 'sale', refId: String(sl._id), amountMinor: cash, employeeId: sl.employeeId ?? null });
      }
      const refunds: any[] = await this.r.posRefundModel.find({ storeId, sessionId: sid }).sort({ createdAt: 1 }).lean();
      for (const rf of refunds) {
        const cash = (rf.tenders ?? []).filter((x: any) => x.method === 'cash').reduce((n: number, x: any) => n + (x.amountMinor ?? toMinor(x.amount ?? 0, exp)), 0);
        if (cash > 0) lines.push({ at: rf.createdAt, sort: 1, type: 'cash_refund', label: `Refund ${rf.reference ?? ''}`.trim(), refType: 'refund', refId: String(rf._id), amountMinor: -cash, employeeId: rf.employeeId ?? null });
      }
      const voids: any[] = await this.r.posCreditNoteModel.find({ storeId, sessionId: sid, kind: 'void', backfill: null }).sort({ createdAt: 1 }).lean();
      for (const v of voids) {
        const cash = (v.tenders ?? []).filter((x: any) => x.method === 'cash').reduce((n: number, x: any) => n + (x.amountMinor ?? 0), 0);
        if (cash > 0) lines.push({ at: v.createdAt, sort: 1, type: 'cash_refund', label: `Void ${v.saleNumber ?? ''}`.trim(), refType: 'void', refId: String(v.saleId), amountMinor: -cash, employeeId: v.employeeId ?? null });
      }
      for (const ad of (s.cashAdjustments ?? []) as any[]) {
        const m = ad.amountMinor ?? toMinor(ad.amount ?? 0, exp);
        const type = ad.category === 'expense' ? 'expense' : ad.category === 'supplier_payment' ? 'supplier_payment' : ad.type;
        lines.push({ at: ad.occurredAt ?? ad.createdAt, sort: 2, type, label: ad.reason ?? type, refType: ad.refType ?? 'cash_movement', refId: ad.refId ?? null, amountMinor: ad.type === 'cash_in' ? m : -m, employeeId: ad.employeeId ?? null });
      }
      lines.sort((x, y) => (x.sort === 0 || y.sort === 0 ? x.sort - y.sort : new Date(x.at).getTime() - new Date(y.at).getTime()));
      let run = 0;
      const out = lines.map((l) => { run += l.amountMinor; return { ...l, runningMinor: run }; });
      const expectedMinor = run;
      const closed = s.status === 'closed';
      const reportExpected = s.expectedCashMinor != null && closed ? s.expectedCashMinor : null;
      const counted = closed ? (s.closingCashMinor ?? (s.closingCash != null ? toMinor(s.closingCash, exp) : null)) : null;
      const variance = closed && counted != null ? counted - (reportExpected ?? expectedMinor) : null;
      // what the shift's own counters say the drawer should hold right now (the same arithmetic the close report uses)
      const counterExpected = (s.openingCashMinor ?? toMinor(s.openingCash ?? 0, exp)) + (s.cashSalesMinor ?? toMinor(s.cashSales ?? 0, exp))
        + ((s.cashAdjustments ?? []) as any[]).reduce((n, ad) => n + (ad.type === 'cash_in' ? 1 : -1) * (ad.amountMinor ?? toMinor(ad.amount ?? 0, exp)), 0);
      const unreconciled = counterExpected - expectedMinor;
      const sumOf = (types: string[]) => out.filter((l) => types.includes(l.type)).reduce((n, l) => n + l.amountMinor, 0);
      const sh = { sessionId: sid, registerId: s.registerId ?? null, registerName: regName.get(String(s.registerId)) ?? null, employeeId: s.employeeId ?? null, employeeName: empName.get(String(s.employeeId)) ?? null, status: s.status, openedAt: s.openedAt, closedAt: s.closedAt ?? null,
        openingMinor, cashSalesMinor: sumOf(['cash_sale']), cashRefundsMinor: -sumOf(['cash_refund']), cashInMinor: sumOf(['cash_in']), cashOutMinor: -sumOf(['cash_out']), expensesMinor: -sumOf(['expense']), supplierPaymentsMinor: -sumOf(['supplier_payment']),
        expectedCashMinor: expectedMinor, shiftExpectedCashMinor: counterExpected, countedMinor: counted, varianceMinor: variance, reconciled: unreconciled === 0, unreconciledMinor: unreconciled, lines: out };
      shifts.push(sh);
      totals.cashSalesMinor += sh.cashSalesMinor; totals.cashRefundsMinor += sh.cashRefundsMinor; totals.cashInMinor += sh.cashInMinor; totals.cashOutMinor += sh.cashOutMinor; totals.expensesMinor += sh.expensesMinor; totals.supplierPaymentsMinor += sh.supplierPaymentsMinor; totals.varianceMinor += variance ?? 0;
    }
    return { success: true, data: { currency, currencyExponent: exp, from, to, ownShiftsOnly: a.role === 'cashier', shifts, totals } };
  }
}
