/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model, Types } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { KhataAccount, KhataAccountDocument, KhataEntry, KhataEntryDocument } from '../khata/khata.schema';
import { isoExponent } from '../common/money-minor.util';
import { AccountingSettings, AccountingSettingsDocument, JournalEntry, JournalEntryDocument } from './accounting.schema';
import { AccountingService } from './accounting.service';
import {
  cashMovementEntry, expenseEntry, financeTxEntry, isSkip, khataEntry, orderRefundEntry, orderSaleEntry, payoutEntry, posRefundEntry, posSaleEntry,
  posVoidEntry, receiptEntry, shiftCloseEntry, stockMovementEntry, supplierEntry, type PostingCtx, type RuleResult,
} from './posting-rules.util';

const BATCH = 500;
/** Per source per run; a big backlog is worked through over the next runs (every 15 minutes). */
const MAX_BATCHES = 40;
const SYSTEM = { id: 'system', role: 'system' };

interface RunStats { posted: Record<string, number>; skipped: Record<string, number>; errors: number }

/**
 * Turns the store's money records into journal entries (Accounting Plan, Phase 1). Each source is read in order of a
 * timestamp from a saved cursor, so a run only looks at what changed; posting is idempotent (one entry per source key),
 * so reading a record twice is harmless. Runs every 15 minutes for stores with accounting on, and on demand.
 */
@Injectable()
export class AccountingSyncService {
  private readonly logger = new Logger(AccountingSyncService.name);
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly accounting: AccountingService,
    @InjectModel(AccountingSettings.name) private readonly settingsModel: Model<AccountingSettingsDocument>,
    @InjectModel(JournalEntry.name) private readonly journal: Model<JournalEntryDocument>,
    @InjectModel(KhataEntry.name) private readonly khataEntries: Model<KhataEntryDocument>,
    @InjectModel(KhataAccount.name) private readonly khataAccounts: Model<KhataAccountDocument>,
  ) {}

  private get r() { return this.db.repositories as any; }

  @Cron('*/15 * * * *')
  async scheduledSync() {
    await this.redis.withLock('accounting:sync:all', 14 * 60_000, async () => {
      const stores = await this.settingsModel.find({ enabled: true }).select('storeId').lean();
      for (const s of stores) {
        try { await this.syncStore(s.storeId); } catch (e: any) { this.logger.error(`Accounting sync failed for store ${s.storeId}: ${e?.message}`); }
      }
    });
  }

  @Cron('35 5 * * *')
  async nightlyCheck() {
    await this.redis.withLock('accounting:check', 30 * 60_000, async () => {
      const stores = await this.settingsModel.find({ enabled: true }).select('storeId').lean();
      for (const s of stores) {
        const c = await this.accounting.check(s.storeId);
        if (!c.ok) this.logger.error(`Accounting: store ${s.storeId} is out of balance (debits ${c.debitMinor}, credits ${c.creditMinor})`);
      }
    });
  }

  /** One store, under a per-store lock. Returns the run's counts, or 'busy' when another run holds the lock. */
  async syncStore(storeId: string): Promise<RunStats | 'busy'> {
    let stats: RunStats | null = null;
    const res = await this.redis.withLock(`accounting:sync:${storeId}`, 15 * 60_000, async () => { stats = await this.run(storeId); });
    return res === 'ran' && stats ? stats : 'busy';
  }

  private async run(storeId: string): Promise<RunStats> {
    const settings = await this.settingsModel.findOne({ storeId, enabled: true }).lean();
    const stats: RunStats = { posted: {}, skipped: {}, errors: 0 };
    if (!settings) return stats;
    const ctx: PostingCtx = { base: settings.baseCurrency, exp: isoExponent(settings.baseCurrency) };
    const goLive = new Date(settings.goLiveDate);
    const cursors: Record<string, string> = { ...(settings.cursors ?? {}) };

    const take = async (source: string, result: RuleResult) => {
      if (isSkip(result)) { stats.skipped[result.skip] = (stats.skipped[result.skip] ?? 0) + 1; return; }
      if (result.date < goLive) { stats.skipped.before_go_live = (stats.skipped.before_go_live ?? 0) + 1; return; }
      const posted = await this.accounting.post(storeId, result, 'auto');
      if (posted) stats.posted[source] = (stats.posted[source] ?? 0) + 1;
    };
    const guarded = (fn: (doc: any) => Promise<void>) => async (doc: any) => {
      try { await fn(doc); } catch (e: any) { stats.errors++; this.logger.warn(`Accounting: could not post ${doc?._id} for store ${storeId}: ${e?.message}`); }
    };

    const scan = async (name: string, model: Model<any>, filter: any, field: string, handle: (doc: any) => Promise<void>) => {
      for (let b = 0; b < MAX_BATCHES; b++) {
        const c = parseCursor(cursors[name]);
        const where = c
          ? { ...filter, $or: [{ [field]: { $gt: c.at } }, { [field]: c.at, _id: { $gt: c.id } }] }
          : { ...filter, [field]: { $gte: goLive } };
        const docs = await model.find(where).sort({ [field]: 1, _id: 1 }).limit(BATCH).lean();
        for (const d of docs) await guarded(handle)(d);
        if (docs.length) {
          const last = docs[docs.length - 1];
          cursors[name] = `${new Date(last[field]).toISOString()}|${String(last._id)}`;
          await this.settingsModel.updateOne({ storeId }, { $set: { [`cursors.${name}`]: cursors[name] } });
        }
        if (docs.length < BATCH) break;
      }
    };

    // POS
    await scan('pos_sales', this.r.saleModel, { storeId }, 'updatedAt', d => take('pos_sale', posSaleEntry(d, ctx)));
    await scan('pos_refunds', this.r.posRefundModel, { storeId }, 'createdAt', async d => {
      const cn = await this.r.posCreditNoteModel.findOne({ storeId, refundId: String(d._id) }).select('taxMinor').lean();
      await take('pos_refund', posRefundEntry(d, cn, ctx));
    });
    await scan('pos_voids', this.r.posCreditNoteModel, { storeId, kind: 'void' }, 'createdAt', d => take('pos_void', posVoidEntry(d, ctx)));
    await scan('pos_sessions', this.r.registerSessionModel, { storeId }, 'updatedAt', async s => {
      const adjs: any[] = s.cashAdjustments ?? [];
      for (let i = 0; i < adjs.length; i++) await take('cash_movement', cashMovementEntry(s, adjs[i], i, ctx));
      await take('shift_close', shiftCloseEntry(s, ctx));
    });
    await scan('pos_expenses', this.r.posExpenseModel, { storeId }, 'createdAt', d => this.expense(storeId, d, ctx, goLive, take, settings.expenseAccounts ?? {}));
    await scan('pos_expense_events', this.r.posExpenseEventModel, { storeId, type: { $in: ['approved', 'rejected'] } }, 'createdAt', async ev => {
      const exp = await this.r.posExpenseModel.findOne({ storeId, _id: ev.expenseId }).lean();
      if (exp) await this.expense(storeId, exp, ctx, goLive, take, settings.expenseAccounts ?? {});
    });

    // Stock and purchasing
    await scan('stock', this.r.stockMovementModel, { storeId }, 'createdAt', d => take('stock', stockMovementEntry(d)));
    await scan('receipts', this.r.purchaseReceiptModel, { storeId }, 'createdAt', d => take('receipt', receiptEntry(d, ctx)));
    await scan('supplier', this.r.supplierLedgerEntryModel, { storeId }, 'createdAt', d => take('supplier', supplierEntry(d, ctx)));

    // Khata
    const khataCurrency = new Map<string, string>();
    await scan('khata', this.khataEntries, { storeId }, 'createdAt', async e => {
      if (!khataCurrency.has(e.accountId)) {
        const acc = await this.khataAccounts.findOne({ storeId, _id: e.accountId }).select('currency').lean();
        khataCurrency.set(e.accountId, acc?.currency ?? ctx.base);
      }
      const original = e.type === 'reversal' && e.reversesEntryId ? await this.khataEntries.findOne({ storeId, _id: e.reversesEntryId }).lean() : undefined;
      await take('khata', khataEntry(e, khataCurrency.get(e.accountId)!, ctx, original ?? undefined));
    });

    // Online orders, Solvexo fees and payouts
    await scan('orders', this.r.orderModel, { 'sellerOrders.storeId': storeId }, 'updatedAt', async o => {
      for (const so of (o.sellerOrders ?? []).filter((x: any) => x.storeId === storeId)) {
        await take('order', orderSaleEntry(o, so, ctx));
        if (!(await this.journal.exists({ storeId, sourceKey: `order:${o._id}:${storeId}` }))) continue; // refunds only after a posted sale
        const prefix = `order_refund:${o._id}:${storeId}:`;
        const prior = await this.journal.find({ storeId, sourceType: 'order_refund', sourceId: String(o._id) }).select('sourceKey totalMinor').lean();
        const already = prior.filter(p => p.sourceKey.startsWith(prefix)).reduce((t, p) => t + p.totalMinor, 0);
        await take('order_refund', orderRefundEntry(o, so, ctx, already, new Date(o.updatedAt ?? Date.now())));
      }
    });
    await scan('fees', this.r.transactionModel, { storeId, type: { $in: ['fee', 'adjustment'] } }, 'createdAt', d => take('fee', financeTxEntry(d, ctx)));
    await scan('payouts', this.r.payoutModel, { storeId }, 'updatedAt', async p => {
      if (p.status === 'reversed') {
        const e = await this.journal.findOne({ storeId, sourceKey: `payout:${p._id}` }).lean();
        if (e && !(await this.journal.exists({ storeId, reversesEntryId: String(e._id) }))) {
          await this.accounting.reverse(storeId, String(e._id), SYSTEM, 'payout reversed', new Date(p.updatedAt ?? Date.now()));
          stats.posted.payout_reversal = (stats.posted.payout_reversal ?? 0) + 1;
        }
        return;
      }
      await take('payout', payoutEntry(p, ctx));
    });

    const inc: Record<string, number> = {};
    for (const [k, v] of Object.entries(stats.skipped)) if (!['zero', 'not_final', 'posted_with_order', 'posted_with_expense', 'posted_with_purchasing', 'not_posted_type', 'open', 'not_recognised', 'not_void'].includes(k)) inc[`skippedTotals.${k}`] = v;
    await this.settingsModel.updateOne({ storeId }, { $set: { lastSyncAt: new Date(), lastSync: stats }, ...(Object.keys(inc).length ? { $inc: inc } : {}) });
    return stats;
  }

  /** A POS expense follows its latest approval decision: rejected → its entry is reversed; approved again → it posts again. */
  private async expense(storeId: string, exp: any, ctx: PostingCtx, goLive: Date, take: (s: string, r: RuleResult) => Promise<void>, accounts: Record<string, string>) {
    const last = await this.r.posExpenseEventModel.findOne({ storeId, expenseId: String(exp._id), type: { $in: ['approved', 'rejected'] } }).sort({ createdAt: -1 }).lean();
    const entries = await this.journal.find({ storeId, sourceType: 'expense', sourceId: String(exp._id), kind: 'auto' }).select('_id').lean();
    const reversed = new Set((await this.journal.find({ storeId, reversesEntryId: { $in: entries.map(e => String(e._id)) } }).select('reversesEntryId').lean()).map(r => r.reversesEntryId));
    const active = entries.filter(e => !reversed.has(String(e._id)));
    if (last?.type === 'rejected') {
      for (const e of active) await this.accounting.reverse(storeId, String(e._id), SYSTEM, 'expense rejected', new Date(last.createdAt ?? Date.now()) < goLive ? goLive : new Date(last.createdAt ?? Date.now()));
      return;
    }
    if (!active.length) await take('expense', expenseEntry(exp, ctx, entries.length ? `:${entries.length}` : '', accounts));
  }
}

function parseCursor(c: string | undefined): { at: Date; id: any } | null {
  if (!c) return null;
  const [iso, id] = c.split('|');
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return { at, id: Types.ObjectId.isValid(id) && id.length === 24 ? new Types.ObjectId(id) : id };
}
