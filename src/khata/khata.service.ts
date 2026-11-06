/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { DatabaseService } from '../database/databaseservice';
import { b2bOrderChanged } from '../b2b/b2b-order.util';
import { KhataAccount, KhataAccountDocument, KhataEntry, KhataEntryDocument } from './khata.schema';
import { agingOf, csvCell, exceedsLimit, round2, validateAmount, type KhataEntryType } from './khata-rules.util';

export interface Actor { id: string; role: string }
export interface PostInput {
  type: KhataEntryType; amount: number; orderId?: string | null; method?: string | null; reference?: string | null; note?: string;
  dueDate?: Date | string | null; entryDate?: Date | string | null; source?: 'manual' | 'order' | 'b2b' | 'pos'; sourceKey?: string | null; reversesEntryId?: string | null;
  /** For entries that mirror something already agreed elsewhere (a placed order): recorded even above the limit, so the ledger stays true. */
  skipLimit?: boolean;
}
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isDup = (e: any) => e?.code === 11000;
const rx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Per-store customer ledger ("khata"). Seller records only. The balance changes ONLY together with an appended entry, in one
 * transaction, through a single atomic update of the account (so two clerks posting at once can neither lose an update nor pass a limit).
 */
@Injectable()
export class KhataService implements OnModuleInit {
  private readonly log = new Logger(KhataService.name);
  constructor(
    @InjectModel(KhataAccount.name) private readonly accounts: Model<KhataAccountDocument>,
    @InjectModel(KhataEntry.name) private readonly entries: Model<KhataEntryDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly activity: ActivityLogService,
    @Optional() private readonly db?: DatabaseService,
  ) {}

  onModuleInit() { b2bOrderChanged.fn = (orderId) => this.syncB2BOrder(orderId); }

  private audit(storeId: string, actor: Actor, action: string, description: string, targetId: string) {
    return this.activity.log({ storeId, category: 'khata', action, description, actorId: actor.id, actorRole: actor.role, targetId, targetType: 'khata_account' } as any).catch(() => undefined);
  }

  /** Finds or creates the account of a store customer (by user id) or of a person added by hand. */
  async ensureAccount(storeId: string, a: { customerId?: string | null; name: string; phone?: string | null; currency: string; creditLimit?: number | null }) {
    const name = str(a.name, 120);
    if (!name) throw new BadRequestException('Customer name is required');
    const customerKey = a.customerId ? String(a.customerId) : `m:${new Types.ObjectId().toHexString()}`;
    const limit = a.creditLimit === undefined ? null : this.parseLimit(a.creditLimit);
    const doc = await this.accounts.findOneAndUpdate(
      { storeId, customerKey },
      { $setOnInsert: { storeId, customerKey, customerId: a.customerId ? String(a.customerId) : null, name, phone: a.phone ? str(a.phone, 30) : null, currency: a.currency, creditLimit: limit, balance: 0, entryCount: 0 } },
      { upsert: true, new: true },
    ).lean();
    return doc as any;
  }

  private parseLimit(v: unknown): number | null {
    if (v === null || v === '' || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1e10) throw new BadRequestException('Credit limit must be zero or more');
    return round2(n);
  }

  async post(storeId: string, accountId: string, input: PostInput, actor: Actor) {
    const type = input.type;
    if (!['sale', 'payment', 'adjustment', 'reversal'].includes(type)) throw new BadRequestException('Unknown entry type');
    let amount: number;
    try { amount = validateAmount(input.amount, { allowNegative: type === 'adjustment' || type === 'reversal' }); } catch (e: any) { throw new BadRequestException(e.message); }
    const signed = type === 'sale' ? Math.abs(amount) : type === 'payment' ? -Math.abs(amount) : amount;
    if (type === 'adjustment' && !str(input.note, 300)) throw new BadRequestException('An adjustment needs a note explaining why');
    const sourceKey = input.sourceKey ?? null;
    if (sourceKey) { const hit = await this.entries.findOne({ storeId, sourceKey }).lean(); if (hit) return { entry: hit as any, duplicate: true }; }

    const limitGuard = signed > 0 && type !== 'reversal' && !input.skipLimit;
    const filter: any = { _id: accountId, storeId, ...(type === 'reversal' ? {} : { archived: false }) };
    if (limitGuard) filter.$expr = { $lte: [{ $add: ['$balance', signed] }, { $ifNull: ['$creditLimit', 1e15] }] };
    const session = await this.connection.startSession();
    try {
      let entry: any;
      await session.withTransaction(async () => {
        const acc: any = await this.accounts.findOneAndUpdate(filter, { $inc: { balance: signed, entryCount: 1 }, $set: { lastEntryAt: new Date() } }, { new: true, session }).lean();
        if (!acc) {
          const exists: any = await this.accounts.findOne({ _id: accountId, storeId }).select('creditLimit balance archived').lean();
          if (!exists) throw new NotFoundException('Account not found');
          if (exists.archived && type !== 'reversal') throw new BadRequestException('This account is archived');
          throw new ConflictException(`This would put the balance above the credit limit (${exists.creditLimit}). Current balance: ${round2(exists.balance)}.`);
        }
        const balanceAfter = round2(acc.balance);
        if (balanceAfter !== acc.balance) await this.accounts.updateOne({ _id: accountId }, { $set: { balance: balanceAfter } }, { session });
        const [doc] = await this.entries.create([{
          storeId, accountId, seq: acc.entryCount, type, amount: signed, balanceAfter, orderId: input.orderId ?? null, method: input.method ? str(input.method, 40) : null,
          reference: input.reference ? str(input.reference, 120) : null, note: str(input.note, 300), dueDate: input.dueDate ? new Date(input.dueDate) : null,
          entryDate: input.entryDate ? new Date(input.entryDate) : new Date(), reversesEntryId: input.reversesEntryId ?? null, source: input.source ?? 'manual', sourceKey,
          actorId: actor.id, actorRole: actor.role,
        }], { session });
        entry = doc.toObject();
      });
      void this.audit(storeId, actor, `khata_${type}`, `Khata ${type} of ${signed}`, accountId);
      return { entry, duplicate: false };
    } catch (e: any) {
      if (isDup(e) && sourceKey) { const hit = await this.entries.findOne({ storeId, sourceKey }).lean(); if (hit) return { entry: hit as any, duplicate: true }; }
      if (isDup(e) && input.reversesEntryId) throw new ConflictException('This entry was already reversed');
      throw e;
    } finally { await session.endSession(); }
  }

  async reverse(storeId: string, entryId: string, note: string | undefined, actor: Actor) {
    const e: any = await this.entries.findOne({ _id: entryId, storeId }).lean();
    if (!e) throw new NotFoundException('Entry not found');
    if (e.type === 'reversal') throw new BadRequestException('A reversal cannot be reversed. Add a new entry instead.');
    return this.post(storeId, e.accountId, { type: 'reversal', amount: -e.amount, note: str(note, 300) || `Reversal of entry #${e.seq}`, reversesEntryId: String(e._id), orderId: e.orderId, source: 'manual' }, actor);
  }

  async setLimit(storeId: string, accountId: string, limit: unknown, actor: Actor) {
    const v = this.parseLimit(limit);
    const acc = await this.accounts.findOneAndUpdate({ _id: accountId, storeId }, { $set: { creditLimit: v } }, { new: true }).lean();
    if (!acc) throw new NotFoundException('Account not found');
    void this.audit(storeId, actor, 'khata_limit', `Credit limit set to ${v ?? 'none'}`, accountId);
    return acc as any;
  }

  async listAccounts(storeId: string, q: { search?: string; owing?: string; page?: number; limit?: number }) {
    const page = Math.max(1, Number(q.page) || 1); const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const f: any = { storeId, archived: false };
    if (q.owing === 'true') f.balance = { $gt: 0 };
    if (q.search) f.$or = [{ name: { $regex: rx(String(q.search).slice(0, 60)), $options: 'i' } }, { phone: { $regex: rx(String(q.search).slice(0, 30)) } }];
    const [items, total, sums] = await Promise.all([
      this.accounts.find(f).sort({ balance: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.accounts.countDocuments(f),
      this.accounts.aggregate([{ $match: { storeId, archived: false, balance: { $gt: 0 } } }, { $group: { _id: null, owed: { $sum: '$balance' }, n: { $sum: 1 } } }]),
    ]);
    return { items, total, page, limit, totalOwed: round2(sums[0]?.owed ?? 0), customersOwing: sums[0]?.n ?? 0 };
  }

  async getAccount(storeId: string, accountId: string) {
    const acc: any = await this.accounts.findOne({ _id: accountId, storeId }).lean();
    if (!acc) throw new NotFoundException('Account not found');
    return acc;
  }

  async listEntries(storeId: string, accountId: string, q: { page?: number; limit?: number }) {
    await this.getAccount(storeId, accountId);
    const page = Math.max(1, Number(q.page) || 1); const limit = Math.min(100, Math.max(1, Number(q.limit) || 30));
    const [items, total] = await Promise.all([
      this.entries.find({ storeId, accountId }).sort({ seq: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.entries.countDocuments({ storeId, accountId }),
    ]);
    const reversed = await this.entries.find({ storeId, accountId, reversesEntryId: { $in: items.map((i: any) => String(i._id)) } }).select('reversesEntryId').lean();
    const rs = new Set(reversed.map((r: any) => r.reversesEntryId));
    return { items: items.map((i: any) => ({ ...i, reversed: rs.has(String(i._id)) })), total, page, limit };
  }

  async aging(storeId: string, accountId: string, now = new Date()) {
    const acc = await this.getAccount(storeId, accountId);
    const rows: any[] = await this.entries.find({ storeId, accountId }).sort({ seq: 1 }).select('type amount entryDate dueDate').limit(5000).lean();
    const r = agingOf(rows.map((x) => ({ type: x.type, amount: x.amount, date: x.entryDate, dueDate: x.dueDate })), now);
    return { balance: round2(acc.balance), currency: acc.currency, ...r };
  }

  /** Entries in a date range with the balance the customer started the period with. */
  async statement(storeId: string, accountId: string, from?: string, to?: string) {
    const acc = await this.getAccount(storeId, accountId);
    const f = from ? new Date(from) : new Date(0); const t = to ? new Date(to) : new Date();
    if (isNaN(f.getTime()) || isNaN(t.getTime())) throw new BadRequestException('Invalid date');
    t.setHours(23, 59, 59, 999);
    const prior: any[] = await this.entries.find({ storeId, accountId, entryDate: { $lt: f } }).sort({ seq: -1 }).limit(1).select('balanceAfter').lean();
    const items: any[] = await this.entries.find({ storeId, accountId, entryDate: { $gte: f, $lte: t } }).sort({ seq: 1 }).limit(5000).lean();
    const opening = round2(prior[0]?.balanceAfter ?? 0);
    return { account: { name: acc.name, phone: acc.phone, currency: acc.currency, creditLimit: acc.creditLimit }, from: f, to: t, openingBalance: opening, closingBalance: round2(items.length ? items[items.length - 1].balanceAfter : opening), items };
  }

  async statementCsv(storeId: string, accountId: string, from?: string, to?: string) {
    const s = await this.statement(storeId, accountId, from, to);
    const head = ['Date', 'Type', 'Reference', 'Note', 'Debit', 'Credit', 'Balance'];
    const rows = s.items.map((e) => [new Date(e.entryDate).toISOString().slice(0, 10), e.type, e.reference ?? e.orderId ?? '', e.note, e.amount > 0 ? e.amount : '', e.amount < 0 ? -e.amount : '', e.balanceAfter]);
    return [head, ['', 'Opening balance', '', '', '', '', s.openingBalance], ...rows, ['', 'Closing balance', '', '', '', '', s.closingBalance]].map((r) => r.map(csvCell).join(',')).join('\r\n');
  }

  async agingReport(storeId: string, now = new Date()) {
    const accs: any[] = await this.accounts.find({ storeId, archived: false, balance: { $gt: 0 } }).sort({ balance: -1 }).limit(500).lean();
    const out: any[] = []; const totals: Record<string, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
    for (const a of accs) {
      const rows: any[] = await this.entries.find({ storeId, accountId: String(a._id) }).sort({ seq: 1 }).select('type amount entryDate dueDate').limit(5000).lean();
      const r = agingOf(rows.map((x) => ({ type: x.type, amount: x.amount, date: x.entryDate, dueDate: x.dueDate })), now);
      for (const k of Object.keys(totals)) totals[k] = round2(totals[k] + (r.buckets as any)[k]);
      out.push({ accountId: String(a._id), name: a.name, phone: a.phone, balance: a.balance, creditLimit: a.creditLimit, buckets: r.buckets });
    }
    return { currency: accs[0]?.currency ?? null, accounts: out, totals };
  }

  /**
   * Mirrors a wholesale terms order into the company's khata account, from the order itself (so it is idempotent and order-independent):
   * the sale at its original total, each credit note as an adjustment, each recorded payment, and a reversal for a voided payment.
   * The B2B receivable stays the source of truth; this is the same debt seen in the customer ledger. Skipped when the order currency
   * differs from the account currency (one account = one currency).
   */
  async syncB2BOrder(orderId: string) {
    const o: any = await this.db?.repositories.orderModel.findById(orderId).select('b2b orderNumber currency sellerOrders.storeId').lean();
    const b = o?.b2b;
    if (!b?.terms) return;
    const storeId = o.sellerOrders?.[0]?.storeId ? String(o.sellerOrders[0].storeId) : null;
    if (!storeId) return;
    const sys: Actor = { id: 'system', role: 'system' };
    const acc: any = await this.ensureAccount(storeId, { customerId: `co:${b.companyId}`, name: b.companyName || 'Company', currency: o.currency });
    if (acc.currency !== o.currency) { this.log.warn(`Khata mirror skipped for order ${orderId}: currency ${o.currency} differs from account ${acc.currency}`); return; }
    const id = String(acc._id);
    const adjustments: any[] = b.adjustments ?? [];
    const original = round2(b.total - adjustments.reduce((s, a) => s + Number(a.amount || 0), 0));
    const label = `Order #${o.orderNumber ?? orderId}`;
    await this.post(storeId, id, { type: 'sale', amount: original, orderId: String(orderId), dueDate: b.dueDate ?? null, note: label, source: 'b2b', sourceKey: `order:${orderId}`, skipLimit: true }, sys);
    for (let i = 0; i < adjustments.length; i++) {
      const a = adjustments[i];
      if (!(Number(a.amount) < 0)) continue;
      await this.post(storeId, id, { type: 'adjustment', amount: Number(a.amount), orderId: String(orderId), note: `${label}: ${a.note || 'credit note'}`, source: 'b2b', sourceKey: `order:${orderId}:adj:${i}`, skipLimit: true, entryDate: a.date }, sys);
    }
    for (const p of b.payments ?? []) {
      const key = `pay:${p._id}`;
      if (!p.voided) {
        await this.post(storeId, id, { type: 'payment', amount: p.amount, orderId: String(orderId), method: p.method, reference: p.reference, note: label, source: 'b2b', sourceKey: key, skipLimit: true, entryDate: p.date }, sys);
      } else {
        const e: any = await this.entries.findOne({ storeId, sourceKey: key }).select('_id').lean();
        if (e) await this.reverse(storeId, String(e._id), `Payment voided on ${label}`, sys).catch((err: any) => { if (!(err instanceof ConflictException)) throw err; });
      }
    }
  }

  /**
   * "Sell on udhaar": puts a finished POS sale (tender "other", i.e. nothing was collected at the till) on a customer's khata account.
   * Idempotent per sale; the seller's credit limit applies. A sale that was later voided/refunded is taken back with releasePosSale.
   */
  async putPosSaleOnAccount(storeId: string, saleId: string, accountId: string, actor: Actor) {
    const sale = await this.loadPosSale(storeId, saleId);
    if (sale.status !== 'completed') throw new BadRequestException('Only a completed sale can be put on a customer account');
    if (sale.paymentMethod !== 'other') throw new BadRequestException('Take the sale with the payment type "Other" (nothing collected), then put it on the account');
    const acc = await this.getAccount(storeId, accountId);
    if (sale.currency && sale.currency !== acc.currency) throw new BadRequestException('The sale currency differs from the account currency');
    if (sale.customerId && acc.customerId && String(sale.customerId) !== String(acc.customerId)) throw new BadRequestException('This sale belongs to a different customer');
    return this.post(storeId, accountId, { type: 'sale', amount: sale.total, note: `POS sale ${sale.saleNumber}`, reference: sale.saleNumber, source: 'pos', sourceKey: `pos:${saleId}` }, actor);
  }

  async releasePosSale(storeId: string, saleId: string, actor: Actor) {
    const sale = await this.loadPosSale(storeId, saleId);
    if (!['voided', 'refunded'].includes(sale.status)) throw new BadRequestException('Only a voided or fully refunded sale can be taken off the account');
    const e: any = await this.entries.findOne({ storeId, sourceKey: `pos:${saleId}` }).select('_id').lean();
    if (!e) throw new NotFoundException('This sale is not on any account');
    return this.reverse(storeId, String(e._id), `POS sale ${sale.saleNumber} ${sale.status}`, actor);
  }

  private async loadPosSale(storeId: string, saleId: string) {
    if (!Types.ObjectId.isValid(saleId)) throw new NotFoundException('Sale not found');
    const sale: any = await this.db?.repositories.saleModel.findOne({ _id: saleId, storeId }).select('status paymentMethod total currency customerId saleNumber').lean();
    if (!sale) throw new NotFoundException('Sale not found');
    return sale;
  }

  /** Checks (without posting) whether a new debit would stay inside the seller's limit. For checkout and the POS. */
  async canTakeOnCredit(storeId: string, customerKey: string, amount: number) {
    const acc: any = await this.accounts.findOne({ storeId, customerKey, archived: false }).select('balance creditLimit').lean();
    if (!acc) return { allowed: true, limit: null, balance: 0 };
    return { allowed: !exceedsLimit(acc.balance, amount, acc.creditLimit), limit: acc.creditLimit ?? null, balance: round2(acc.balance) };
  }
}
