/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import '../../common/schema-types/minor-money';
import { makeAppendOnly } from './pos-immutable.util';

export const EXPENSE_CATEGORIES = ['rent', 'utilities', 'salaries', 'supplies', 'transport', 'repairs', 'marketing', 'meals', 'taxes_fees', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const EXPENSE_METHODS = ['cash', 'bank', 'other'] as const;

export type PosExpenseDocument = PosExpense & Document;
/**
 * G3.5: an expense — APPEND-ONLY, minor units only. A drawer (`cash`) expense also took money out of the open shift in the same transaction (a `cash_out` row on the shift,
 * category `expense`); `bank` / `other` are recorded only. What happens to an expense later (approved / rejected, a receipt photo attached) is a row in `PosExpenseEvent`, never an edit.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class PosExpense {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) number: string;
  @Prop({ type: Number, required: true }) seq: number;
  @Prop({ type: String, enum: EXPENSE_CATEGORIES, required: true }) category: string;
  @Prop({ type: 'MinorMoney', required: true }) amountMinor: number;
  @Prop({ type: String, required: true }) currency: string;
  @Prop({ type: Number, required: true }) currencyExponent: number;
  @Prop({ type: String, default: null }) payee: string | null;
  @Prop({ type: String, enum: EXPENSE_METHODS, required: true }) method: string;
  @Prop({ type: String, default: null }) note: string | null;
  /** when it really happened (the device's time for an expense recorded offline) */
  @Prop({ type: Date, required: true }) occurredAt: Date;
  /** drawer expenses: the shift the money came out of */
  @Prop({ type: String, default: null }) sessionId: string | null;
  @Prop({ type: String, default: null }) registerId: string | null;
  @Prop({ type: String, default: null }) employeeId: string | null;
  @Prop({ type: String, default: null }) approvedBy: string | null;
  @Prop({ type: String, default: null }) deviceId: string | null;
  @Prop({ type: String, default: null }) requestId: string | null;
  createdAt?: Date;
}
export const PosExpenseSchema = SchemaFactory.createForClass(PosExpense);
PosExpenseSchema.set('toJSON', { getters: true, virtuals: false });
PosExpenseSchema.set('toObject', { getters: true, virtuals: false });
PosExpenseSchema.index({ storeId: 1, seq: 1 }, { unique: true });
PosExpenseSchema.index({ storeId: 1, occurredAt: -1 });
PosExpenseSchema.index({ storeId: 1, requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } });
makeAppendOnly(PosExpenseSchema);

export type PosExpenseEventDocument = PosExpenseEvent & Document;
export const EXPENSE_EVENT_TYPES = ['approved', 'rejected', 'receipt_attached'] as const;
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class PosExpenseEvent {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) expenseId: string;
  @Prop({ type: String, enum: EXPENSE_EVENT_TYPES, required: true }) type: string;
  @Prop({ type: String, default: null }) note: string | null;
  /** receipt_attached: where the PRIVATE file lives (never a public URL) */
  @Prop({ type: Object, default: null }) receipt: { publicId: string; resourceType: string; mimeType: string; fileSize: number } | null;
  @Prop({ type: String, default: null }) employeeId: string | null;
  @Prop({ type: String, default: null }) deviceId: string | null;
  createdAt?: Date;
}
export const PosExpenseEventSchema = SchemaFactory.createForClass(PosExpenseEvent);
PosExpenseEventSchema.index({ storeId: 1, expenseId: 1, createdAt: 1 });
makeAppendOnly(PosExpenseEventSchema);
