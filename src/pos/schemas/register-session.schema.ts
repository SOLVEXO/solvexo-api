/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import '../../common/schema-types/minor-money';

export type RegisterSessionDocument = RegisterSession & Document;

@Schema({ _id: true, timestamps: true })
export class CashAdjustment {
  @Prop({ enum: ['cash_in', 'cash_out'], required: true })
  type: string;

  @Prop({ type: Number, required: true })
  amount: number;
  // G1b: integer minor-unit twin
  @Prop({ type: 'MinorMoney' }) amountMinor?: number;

  @Prop({ required: true })
  reason: string;

  @Prop({ required: true })
  employeeId: string;

  @Prop({ type: Date, default: () => new Date() })
  createdAt: Date;
}
export const CashAdjustmentSchema = SchemaFactory.createForClass(CashAdjustment);

@Schema({ timestamps: true })
export class RegisterSession {
  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true })
  registerId: string;

  // Denormalized from the register at session-open time — lets per-location
  // reports query RegisterSession directly without joining through Store.registers.
  @Prop({ type: String, default: null })
  locationId: string | null;

  @Prop({ required: true })
  employeeId: string;

  @Prop({ type: String, default: null })
  shiftId: string | null;

  @Prop({ required: true })
  openedAt: Date;

  @Prop({ type: Date, default: null })
  closedAt: Date | null;

  @Prop({ type: Number, default: 0 })
  openingCash: number;
  // G1b: integer minor-unit twin (counters are `$inc`-ed as integers — no float drift)
  @Prop({ type: 'MinorMoney' }) openingCashMinor?: number;

  // Currency snapshot (Phase 5B): every cash figure on this session is in this currency, rounded to its exponent.
  @Prop({ type: String, default: null })
  currency: string | null;

  @Prop({ type: Number, default: null })
  currencyExponent: number | null;

  @Prop({ type: Number, default: null })
  closingCash: number | null;
  @Prop({ type: 'MinorMoney' }) closingCashMinor?: number;

  @Prop({ type: Number, default: 0 })
  expectedCash: number;
  @Prop({ type: 'MinorMoney' }) expectedCashMinor?: number;

  @Prop({ type: Number, default: 0 })
  cashDifference: number;
  @Prop({ type: 'MinorMoney' }) cashDifferenceMinor?: number;

  @Prop({ type: Number, default: 0 })
  cashSales: number;
  @Prop({ type: 'MinorMoney' }) cashSalesMinor?: number;

  @Prop({ type: Number, default: 0 })
  cardSales: number;
  @Prop({ type: 'MinorMoney' }) cardSalesMinor?: number;

  @Prop({ type: Number, default: 0 })
  otherSales: number;
  @Prop({ type: 'MinorMoney' }) otherSalesMinor?: number;

  @Prop({ type: Number, default: 0 })
  totalSales: number;
  @Prop({ type: 'MinorMoney' }) totalSalesMinor?: number;

  @Prop({ type: Number, default: 0 })
  totalTransactions: number;

  @Prop({ type: Number, default: 0 })
  totalRefunds: number;
  @Prop({ type: 'MinorMoney' }) totalRefundsMinor?: number;

  @Prop({ type: [CashAdjustmentSchema], default: [] })
  cashAdjustments: CashAdjustment[];

  @Prop({ enum: ['open', 'closed'], default: 'open' })
  status: string;

  @Prop({ type: String, default: null })
  forceClosedBy: string | null;  // sellerId or employeeId

  @Prop({ type: String, default: null })
  forceCloseReason: string | null;

  @Prop({ type: Date, default: null })
  forceCloseAt: Date | null;

  // G1b backfill markers
  @Prop({ type: Date })
  minorBackfilledAt?: Date;

  @Prop({ type: Boolean })
  currencyInferred?: boolean;

  // G1a card reconciliation at close. `status` is 'not_reconciled' whenever the cashier did not enter the terminal
  // settlement-slip total (old app builds, or skipped) — the close itself works exactly as before.
  @Prop({
    type: {
      _id: false,
      status: { type: String, enum: ['not_reconciled', 'matched', 'variance_approved'], default: 'not_reconciled' },
      slipTotal: { type: Number, default: null },
      expectedCard: { type: Number, default: null },
      variance: { type: Number, default: null },
      slipTotalMinor: { type: 'MinorMoney' },
      expectedCardMinor: { type: 'MinorMoney' },
      varianceMinor: { type: 'MinorMoney' }, // signed
      approvedBy: { type: String, default: null },
      approvedAt: { type: Date, default: null },
    },
    default: null,
  })
  cardReconciliation: { status: string; slipTotal: number | null; expectedCard: number | null; variance: number | null; slipTotalMinor?: number; expectedCardMinor?: number; varianceMinor?: number; approvedBy: string | null; approvedAt: Date | null } | null;
}

export const RegisterSessionSchema = SchemaFactory.createForClass(RegisterSession);
RegisterSessionSchema.set('toJSON', { getters: true, virtuals: false });
RegisterSessionSchema.set('toObject', { getters: true, virtuals: false });

RegisterSessionSchema.index({ storeId: 1, status: 1 });
RegisterSessionSchema.index({ employeeId: 1 });
RegisterSessionSchema.index({ registerId: 1 });
// At most ONE open session per register, enforced by the database (not just the service-level
// findOne check, which two terminals opening at the same instant can both pass). Partial, so
// closed sessions — any number per register — are unaffected.
// NOTE: building this on a database that already holds two `open` sessions for one register
// fails (Mongo logs it, the app keeps running) — close/force-close the duplicates first.
RegisterSessionSchema.index(
  { registerId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'open' }, name: 'uniq_open_session_per_register' },
);
RegisterSessionSchema.index({ shiftId: 1 });
RegisterSessionSchema.index({ storeId: 1, createdAt: -1 });
RegisterSessionSchema.index({ locationId: 1, createdAt: -1 });
