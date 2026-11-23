/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { makeAppendOnly } from '../pos/schemas/pos-immutable.util';
import { ACCOUNT_TYPES } from './chart.const';

/** One account of a store's chart. `key` never changes (posting rules use it); name, code and the accountant's code may. */
@Schema({ timestamps: true, collection: 'ledger_accounts' })
export class LedgerAccount {
  @Prop({ required: true, index: true }) storeId: string;
  @Prop({ required: true }) key: string;
  @Prop({ required: true, trim: true, maxlength: 20 }) code: string;
  @Prop({ required: true, trim: true, maxlength: 120 }) name: string;
  @Prop({ required: true, enum: ACCOUNT_TYPES }) type: string;
  @Prop({ type: String, default: '', maxlength: 60 }) group: string;
  /** A default account (from the chart): its type is fixed and it cannot be archived. */
  @Prop({ default: false }) system: boolean;
  /** The code this account has in the seller's accounting app (Tally ledger name, Odoo/ERPNext account), used by later exports. */
  @Prop({ type: String, default: null, maxlength: 120 }) externalCode: string | null;
  @Prop({ default: false }) archived: boolean;
}
export type LedgerAccountDocument = HydratedDocument<LedgerAccount>;
export const LedgerAccountSchema = SchemaFactory.createForClass(LedgerAccount);
LedgerAccountSchema.index({ storeId: 1, key: 1 }, { unique: true });
LedgerAccountSchema.index({ storeId: 1, code: 1 }, { unique: true });

/** A store's accounting switch, go-live date and the sync job's state. */
@Schema({ timestamps: true, collection: 'accounting_settings' })
export class AccountingSettings {
  @Prop({ required: true, unique: true }) storeId: string;
  @Prop({ default: false }) enabled: boolean;
  /** The books start here: events dated before it are not posted (their effect is in the opening balances). */
  @Prop({ type: Date, required: true }) goLiveDate: Date;
  /** Fixed when accounting is turned on; every journal amount is in this currency's minor units. */
  @Prop({ required: true }) baseCurrency: string;
  @Prop({ default: 0 }) entrySeq: number;
  @Prop({ type: String, default: null }) openingEntryId: string | null;
  /** Per source: the scan field value the sync reached (records are re-read from here; posting is idempotent). */
  @Prop({ type: Object, default: {} }) cursors: Record<string, string>;
  @Prop({ type: Date, default: null }) lastSyncAt: Date | null;
  /** The last sync's counts: posted per source, and what was left out and why (e.g. a foreign currency). */
  @Prop({ type: Object, default: null }) lastSync: { posted: Record<string, number>; skipped: Record<string, number>; errors: number } | null;
  /** Cumulative counts of records left out, by reason, since go-live (shown on the setup screen). */
  @Prop({ type: Object, default: {} }) skippedTotals: Record<string, number>;
  @Prop({ type: Object, default: null }) lastCheck: { at: Date; ok: boolean; debitMinor: number; creditMinor: number; entries: number } | null;
  @Prop({ type: String, default: null }) enabledBy: string | null;
  /** Expense category → the account it posts to, where the store changed the default (chart.const EXPENSE_CATEGORY_ACCOUNT). */
  @Prop({ type: Object, default: {} }) expenseAccounts: Record<string, string>;
}
export type AccountingSettingsDocument = HydratedDocument<AccountingSettings>;
export const AccountingSettingsSchema = SchemaFactory.createForClass(AccountingSettings);
AccountingSettingsSchema.index({ enabled: 1 });

@Schema({ _id: false })
export class JournalLine {
  @Prop({ required: true }) accountKey: string;
  /** Minor units of the store's base currency; exactly one of debit / credit is non-zero. */
  @Prop({ required: true, default: 0 }) debitMinor: number;
  @Prop({ required: true, default: 0 }) creditMinor: number;
  @Prop({ type: String, default: '' , maxlength: 200 }) memo: string;
}
export const JournalLineSchema = SchemaFactory.createForClass(JournalLine);

export const JOURNAL_KINDS = ['auto', 'manual', 'opening', 'reversal'] as const;

/**
 * One balanced journal entry. APPEND-ONLY: a mistake is corrected by a reversal entry (`reversesEntryId`), never by editing.
 * `sourceKey` makes every automatic entry idempotent: the same event can never post twice.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'journal_entries' })
export class JournalEntry {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) seq: number;
  @Prop({ type: Date, required: true }) date: Date;
  @Prop({ required: true, enum: JOURNAL_KINDS }) kind: string;
  /** What caused it: pos_sale, pos_refund, pos_void, expense, cash_movement, shift_close, stock, receipt, supplier, khata, order, order_refund, fee, payout, manual, opening. */
  @Prop({ required: true }) sourceType: string;
  @Prop({ type: String, default: null }) sourceId: string | null;
  @Prop({ required: true }) sourceKey: string;
  /** A short human reference (invoice, receipt or order number). */
  @Prop({ type: String, default: '', maxlength: 80 }) reference: string;
  @Prop({ type: String, default: '', maxlength: 300 }) memo: string;
  @Prop({ type: [JournalLineSchema], required: true }) lines: JournalLine[];
  @Prop({ required: true }) totalMinor: number;
  @Prop({ required: true }) currency: string;
  @Prop({ type: String, default: null }) reversesEntryId: string | null;
  @Prop({ default: '' }) actorId: string;
  createdAt?: Date;
}
export type JournalEntryDocument = HydratedDocument<JournalEntry>;
export const JournalEntrySchema = SchemaFactory.createForClass(JournalEntry);
JournalEntrySchema.index({ storeId: 1, sourceKey: 1 }, { unique: true });
JournalEntrySchema.index({ storeId: 1, seq: 1 }, { unique: true });
JournalEntrySchema.index({ storeId: 1, date: -1 });
JournalEntrySchema.index({ storeId: 1, 'lines.accountKey': 1, date: 1 });
JournalEntrySchema.index({ storeId: 1, sourceType: 1, sourceId: 1 });
JournalEntrySchema.index({ storeId: 1, reversesEntryId: 1 }, { unique: true, partialFilterExpression: { reversesEntryId: { $type: 'string' } } });
makeAppendOnly(JournalEntrySchema);
