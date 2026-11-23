/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { isoExponent, isSafeMinor } from '../common/money-minor.util';
import { EXPENSE_CATEGORIES } from '../pos/schemas/pos-expense.schema';
import { PosCashService } from '../pos/pos-cash.service';
import { PosReportsService } from '../pos/pos-reports.service';
import { PosSupplyService } from '../pos/pos-supply.service';
import { AccountingSettings, AccountingSettingsDocument, LedgerAccount, LedgerAccountDocument } from './accounting.schema';
import { EXPENSE_CATEGORY_ACCOUNT } from './chart.const';

/** Web expenses: paid by cash (not from a till drawer: petty cash or the owner's cash), bank, or other. */
export const WEB_EXPENSE_METHODS = ['cash', 'bank', 'other'] as const;
const NONE = {};

/**
 * Accounting Plan, Phase 2: the books screens on the web. Expense lists, approvals and receipts, the shift daybook, supplier balances
 * and the POS profit / tax reports already exist for the POS app; the web reaches the SAME code as the store owner, so both show the
 * same figures. Access on the web is the staff permission (accounting.view / accounting.manage), checked by the controller.
 * Only two things are new here: recording an expense from the web, and choosing which account each expense category posts to.
 */
@Injectable()
export class AccountingBooksService {
  constructor(
    private readonly db: DatabaseService,
    private readonly cash: PosCashService,
    private readonly reports: PosReportsService,
    private readonly supply: PosSupplyService,
    @InjectModel(AccountingSettings.name) private readonly settingsModel: Model<AccountingSettingsDocument>,
    @InjectModel(LedgerAccount.name) private readonly accounts: Model<LedgerAccountDocument>,
  ) {}
  private get r(): any { return this.db.repositories; }

  /** The request as the store owner, for the POS services' own owner / manager / cashier matrix. */
  private asOwner(store: any) { return { user: { userId: String(store.sellerId), role: 'seller' } } as any; }

  // ── Expenses ────────────────────────────────────────────────────────────────────────────────────────────────────────
  expenses(store: any, q: any) { return this.cash.expenses(this.asOwner(store), String(store._id), q, NONE); }
  expense(store: any, id: string) { return this.cash.expenseGet(this.asOwner(store), String(store._id), id, NONE); }
  decide(store: any, id: string, body: any) { return this.cash.expenseDecide(this.asOwner(store), String(store._id), id, body, NONE); }
  receiptUpload(store: any, id: string, file: Express.Multer.File | undefined) { return this.cash.receiptUpload(this.asOwner(store), String(store._id), id, file, NONE); }
  receiptLink(store: any, id: string) { return this.cash.receiptLink(this.asOwner(store), String(store._id), id, NONE); }
  daybook(store: any, q: any) { return this.cash.daybook(this.asOwner(store), String(store._id), q, NONE); }

  /**
   * An expense recorded on the web. Same numbering (EXP-000123) and records as the POS, so it appears in the POS app, its reports and the books.
   * It never touches a till drawer. Recorded by someone who manages the books, so it is approved at once.
   */
  async createExpense(store: any, body: any, actor: { id: string; role: string }) {
    const storeId = String(store._id);
    const category = String(body?.category ?? '');
    if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category)) throw new BadRequestException('Choose an expense category.');
    const method = String(body?.method ?? '');
    if (!(WEB_EXPENSE_METHODS as readonly string[]).includes(method)) throw new BadRequestException('Choose how it was paid: cash, bank or other.');
    const amountMinor = body?.amountMinor;
    if (!isSafeMinor(amountMinor) || amountMinor <= 0) throw new BadRequestException('The amount must be above 0.');
    const text = (v: any, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const payee = text(body?.payee, 120), note = text(body?.note, 300);
    if (category === 'other' && !note) throw new BadRequestException('Add a note for "other".');
    const occurredAt = body?.occurredAt ? new Date(body.occurredAt) : new Date();
    if (Number.isNaN(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('The date is not valid.');
    const requestId = text(body?.requestId, 100) ?? `web:${randomBytes(8).toString('hex')}`;
    const existing = await this.r.posExpenseModel.findOne({ storeId, requestId }).lean();
    if (existing) return this.expense(store, String(existing._id));
    const currency = String(store.baseCurrency || 'USD').toUpperCase();
    await this.r.posSettingsModel.updateOne({ storeId }, { $setOnInsert: { storeId } }, { upsert: true });
    let id: string;
    try {
      id = await this.r.registerSessionModel.db.transaction(async (tx: any) => {
        const s: any = await this.r.posSettingsModel.findOneAndUpdate({ storeId }, { $inc: { expenseCounter: 1 } }, { new: true, upsert: true, session: tx });
        const seq = Number(s.expenseCounter);
        const [e] = await this.r.posExpenseModel.create([{
          storeId, number: `EXP-${String(seq).padStart(6, '0')}`, seq, category, amountMinor, currency, currencyExponent: isoExponent(currency),
          payee, method, note, occurredAt, sessionId: null, registerId: null, employeeId: null, approvedBy: null, deviceId: null, requestId,
        }], { session: tx });
        await this.r.posExpenseEventModel.create([{ storeId, expenseId: String(e._id), type: 'approved', note: 'Recorded on the web', employeeId: null }], { session: tx });
        await this.r.posAuditLogModel.create([{ storeId, employeeId: null, action: 'expense_recorded', targetId: String(e._id), targetType: 'cash', metadata: { number: e.number, category, amountMinor, method, source: 'web', actorId: actor.id, actorRole: actor.role } }], { session: tx });
        return String(e._id);
      });
    } catch (e: any) {
      if (e?.code === 11000) { const dup = await this.r.posExpenseModel.findOne({ storeId, requestId }).lean(); if (dup) return this.expense(store, String(dup._id)); }
      throw e;
    }
    return this.expense(store, id);
  }

  // ── Supplier balances ───────────────────────────────────────────────────────────────────────────────────────────────
  payables(store: any) { return this.supply.payables(this.asOwner(store), String(store._id), NONE); }
  supplierLedger(store: any, supplierId: string) { return this.supply.ledger(this.asOwner(store), String(store._id), supplierId, NONE); }

  // ── POS profit and tax ──────────────────────────────────────────────────────────────────────────────────────────────
  profit(store: any, q: any) { return this.reports.profit(this.asOwner(store), String(store._id), q, NONE); }
  tax(store: any, q: any) { return this.reports.tax(this.asOwner(store), String(store._id), q, NONE); }

  // ── Expense category → account ──────────────────────────────────────────────────────────────────────────────────────
  async expenseAccounts(storeId: string) {
    const s = await this.settingsModel.findOne({ storeId }).select('expenseAccounts').lean();
    const chosen = s?.expenseAccounts ?? {};
    return { categories: EXPENSE_CATEGORIES.map(c => ({ category: c, accountKey: chosen[c] ?? EXPENSE_CATEGORY_ACCOUNT[c], defaultAccountKey: EXPENSE_CATEGORY_ACCOUNT[c] })) };
  }

  /** Only expense accounts that are not archived. Applies to expenses posted from now on; entries already posted stay as they are. */
  async setExpenseAccounts(storeId: string, body: any) {
    const input = body?.accounts && typeof body.accounts === 'object' ? body.accounts : {};
    const valid = new Map((await this.accounts.find({ storeId, type: 'expense', archived: false }).select('key').lean()).map(a => [a.key, true]));
    const out: Record<string, string> = {};
    for (const c of EXPENSE_CATEGORIES) {
      const k = input[c];
      if (k === undefined || k === null || k === '' || k === EXPENSE_CATEGORY_ACCOUNT[c]) continue;
      if (typeof k !== 'string' || !valid.has(k)) throw new BadRequestException(`"${c}" must post to an expense account.`);
      out[c] = k;
    }
    await this.settingsModel.updateOne({ storeId, enabled: true }, { $set: { expenseAccounts: out } });
    return this.expenseAccounts(storeId);
  }
}
