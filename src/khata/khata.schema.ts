/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/** One customer's running account with ONE store. Seller records only: Solvexo moves no money. */
@Schema({ timestamps: true, collection: 'khata_accounts' })
export class KhataAccount {
  @Prop({ required: true, index: true }) storeId: string;
  /** The store customer's user id, or `m:<random>` for a person added by hand. */
  @Prop({ required: true }) customerKey: string;
  @Prop({ type: String, default: null }) customerId: string | null;
  @Prop({ required: true, trim: true, maxlength: 120 }) name: string;
  @Prop({ type: String, default: null, maxlength: 30 }) phone: string | null;
  @Prop({ type: Number, default: null, min: 0 }) creditLimit: number | null;
  @Prop({ required: true }) currency: string;
  /** Amount the customer owes (positive) or has paid in advance (negative). Moved only together with a ledger entry. */
  @Prop({ type: Number, default: 0 }) balance: number;
  @Prop({ type: Number, default: 0 }) entryCount: number;
  @Prop({ type: Date, default: null }) lastEntryAt: Date | null;
  @Prop({ default: false }) archived: boolean;
  @Prop({ type: Date, default: null }) lastReminderAt: Date | null;
}
export type KhataAccountDocument = HydratedDocument<KhataAccount>;
export const KhataAccountSchema = SchemaFactory.createForClass(KhataAccount);
KhataAccountSchema.index({ storeId: 1, customerKey: 1 }, { unique: true });

/** Append-only. A mistake is corrected by a reversal entry, never by editing or deleting. */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'khata_entries' })
export class KhataEntry {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) accountId: string;
  @Prop({ required: true }) seq: number;
  @Prop({ required: true, enum: ['sale', 'payment', 'adjustment', 'reversal'] }) type: string;
  /** Signed: positive = customer owes more. */
  @Prop({ required: true }) amount: number;
  @Prop({ required: true }) balanceAfter: number;
  @Prop({ type: String, default: null }) orderId: string | null;
  @Prop({ type: String, default: null, maxlength: 40 }) method: string | null;
  @Prop({ type: String, default: null, maxlength: 120 }) reference: string | null;
  @Prop({ type: String, default: '', maxlength: 300 }) note: string;
  @Prop({ type: Date, default: null }) dueDate: Date | null;
  @Prop({ type: Date, required: true }) entryDate: Date;
  @Prop({ type: String, default: null }) reversesEntryId: string | null;
  @Prop({ required: true, enum: ['manual', 'order', 'b2b', 'pos'] }) source: string;
  /** Makes automatic entries idempotent (e.g. `order:<id>`). */
  @Prop({ type: String, default: null }) sourceKey: string | null;
  @Prop({ default: '' }) actorId: string;
  @Prop({ default: '' }) actorRole: string;
}
export type KhataEntryDocument = HydratedDocument<KhataEntry>;
export const KhataEntrySchema = SchemaFactory.createForClass(KhataEntry);
KhataEntrySchema.index({ accountId: 1, seq: 1 }, { unique: true });
KhataEntrySchema.index({ storeId: 1, sourceKey: 1 }, { unique: true, partialFilterExpression: { sourceKey: { $type: 'string' } } });
KhataEntrySchema.index({ storeId: 1, reversesEntryId: 1 }, { unique: true, partialFilterExpression: { reversesEntryId: { $type: 'string' } } });
