/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RegisterSessionDocument = RegisterSession & Document;

@Schema({ _id: true, timestamps: true })
export class CashAdjustment {
  @Prop({ enum: ['cash_in', 'cash_out'], required: true })
  type: string;

  @Prop({ type: Number, required: true })
  amount: number;

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

  @Prop({ type: Number, default: null })
  closingCash: number | null;

  @Prop({ type: Number, default: 0 })
  expectedCash: number;

  @Prop({ type: Number, default: 0 })
  cashDifference: number;

  @Prop({ type: Number, default: 0 })
  cashSales: number;

  @Prop({ type: Number, default: 0 })
  cardSales: number;

  @Prop({ type: Number, default: 0 })
  otherSales: number;

  @Prop({ type: Number, default: 0 })
  totalSales: number;

  @Prop({ type: Number, default: 0 })
  totalTransactions: number;

  @Prop({ type: Number, default: 0 })
  totalRefunds: number;

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
}

export const RegisterSessionSchema = SchemaFactory.createForClass(RegisterSession);

RegisterSessionSchema.index({ storeId: 1, status: 1 });
RegisterSessionSchema.index({ employeeId: 1 });
RegisterSessionSchema.index({ registerId: 1 });
RegisterSessionSchema.index({ shiftId: 1 });
RegisterSessionSchema.index({ storeId: 1, createdAt: -1 });
RegisterSessionSchema.index({ locationId: 1, createdAt: -1 });
