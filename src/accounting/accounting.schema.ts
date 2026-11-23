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
  /** Sales channel (pos, online, b2b, other) and branch (POS location) for statements by channel / branch. Null on entries made before Phase 3. */
  @Prop({ type: String, default: null }) channel: string | null;
  @Prop({ type: String, default: null }) locationId: string | null;
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

/**
 * One imported payment-gateway settlement report (JazzCash, Easypaisa, Safepay, …): what the gateway paid into the bank, net of its fees.
 * Each line is matched to the store's orders by the gateway's transaction reference or the order number. Posting it moves the gross
 * out of "Online payment gateways clearing" into the bank, with the fees as processing fees. Posted once; a posted import cannot change.
 */
@Schema({ timestamps: true, collection: 'gateway_settlements' })
export class GatewaySettlement {
  @Prop({ required: true, index: true }) storeId: string;
  @Prop({ required: true, maxlength: 40 }) gateway: string;
  @Prop({ type: String, default: '', maxlength: 120 }) fileName: string;
  /** The date the money reached the bank (the posting date). */
  @Prop({ type: Date, required: true }) settledOn: Date;
  @Prop({ required: true }) currency: string;
  @Prop({ type: [Object], default: [] }) lines: Array<{
    row: number; date: string | null; reference: string; grossMinor: number; feeMinor: number; netMinor: number;
    match: { status: 'matched' | 'unmatched' | 'amount_differs' | 'duplicate'; orderIds: string[]; orderNumbers: string[]; expectedMinor: number | null };
  }>;
  @Prop({ type: Object, required: true }) totals: { grossMinor: number; feeMinor: number; netMinor: number; matched: number; unmatched: number };
  @Prop({ default: 'draft', enum: ['draft', 'posted', 'discarded'] }) status: string;
  @Prop({ type: String, default: null }) journalEntryId: string | null;
  @Prop({ default: '' }) importedBy: string;
}
export type GatewaySettlementDocument = HydratedDocument<GatewaySettlement>;
export const GatewaySettlementSchema = SchemaFactory.createForClass(GatewaySettlement);
GatewaySettlementSchema.index({ storeId: 1, createdAt: -1 });

export const INTEGRATION_APPS = ['odoo', 'erpnext'] as const;

/**
 * A store's connection to its accounting app (Phase 4). The API key / secret is stored encrypted (INTEGRATIONS key) and never returned.
 * `mode` detail = one entry per Solvexo journal entry (default for Odoo / ERPNext); summary = one entry per day.
 */
@Schema({ timestamps: true, collection: 'accounting_connections' })
export class AccountingConnection {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true, enum: INTEGRATION_APPS }) app: string;
  @Prop({ required: true, maxlength: 300 }) baseUrl: string;
  /** Odoo: the database name. */
  @Prop({ type: String, default: null, maxlength: 120 }) database: string | null;
  /** Odoo: the user's login (e-mail). */
  @Prop({ type: String, default: null, maxlength: 200 }) login: string | null;
  /** ERPNext: the company the entries belong to. */
  @Prop({ type: String, default: null, maxlength: 200 }) company: string | null;
  /** Odoo: the code of the journal the entries go to (Miscellaneous Operations by default). */
  @Prop({ type: String, default: 'MISC', maxlength: 20 }) journalCode: string;
  @Prop({ required: true }) secretEnc: string;
  @Prop({ default: '' }) secretHint: string;
  @Prop({ default: 'detail', enum: ['detail', 'summary'] }) mode: string;
  @Prop({ default: true }) enabled: boolean;
  /** detail: the last journal entry number sent; summary: the last day sent (YYYY-MM-DD). */
  @Prop({ default: 0 }) cursorSeq: number;
  @Prop({ type: String, default: null }) cursorDay: string | null;
  @Prop({ type: Date, default: null }) lastSyncAt: Date | null;
  @Prop({ type: Object, default: null }) lastCheck: { at: Date; ok: boolean; message: string } | null;
  @Prop({ default: '' }) createdBy: string;
}
export type AccountingConnectionDocument = HydratedDocument<AccountingConnection>;
export const AccountingConnectionSchema = SchemaFactory.createForClass(AccountingConnection);
AccountingConnectionSchema.index({ storeId: 1, app: 1 }, { unique: true });
AccountingConnectionSchema.index({ enabled: 1 });

/** What was sent to an accounting app, one row per entry (or day): sent, failed (with the reason, retried up to 5 times) or skipped. */
@Schema({ timestamps: true, collection: 'accounting_export_log' })
export class AccountingExportLog {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) app: string;
  /** `entry:<seq>` or `day:<YYYY-MM-DD>`. */
  @Prop({ required: true }) itemKey: string;
  @Prop({ required: true, enum: ['sent', 'failed', 'skipped'] }) status: string;
  @Prop({ default: 0 }) attempts: number;
  @Prop({ type: String, default: null }) externalId: string | null;
  @Prop({ type: String, default: null, maxlength: 500 }) error: string | null;
  @Prop({ type: String, default: '', maxlength: 200 }) label: string;
  @Prop({ default: 0 }) amountMinor: number;
  @Prop({ type: Date, default: null }) lastTriedAt: Date | null;
}
export type AccountingExportLogDocument = HydratedDocument<AccountingExportLog>;
export const AccountingExportLogSchema = SchemaFactory.createForClass(AccountingExportLog);
AccountingExportLogSchema.index({ storeId: 1, app: 1, itemKey: 1 }, { unique: true });
AccountingExportLogSchema.index({ storeId: 1, app: 1, status: 1, updatedAt: -1 });
