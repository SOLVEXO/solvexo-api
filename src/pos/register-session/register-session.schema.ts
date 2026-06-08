/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RegisterSessionDocument = RegisterSession & Document;

@Schema({ timestamps: true })
export class RegisterSession {
  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true })
  registerId: string;

  @Prop({ required: true })
  employeeId: string;

  @Prop({ default: null })
  shiftId: string;

  @Prop({ required: true })
  openedAt: Date;

  @Prop({ default: null })
  closedAt: Date;

  @Prop({ type: Number, default: 0 })
  openingCash: number;

  @Prop({ type: Number, default: null })
  closingCash: number;

  @Prop({ type: Number, default: 0 })
  expectedCash: number;

  @Prop({ type: Number, default: 0 })
  cashDifference: number;

  @Prop({ type: Number, default: 0 })
  cashSales: number;

  @Prop({ type: Number, default: 0 })
  cardSales: number;

  @Prop({ type: Number, default: 0 })
  totalSales: number;

  @Prop({ type: Number, default: 0 })
  totalTransactions: number;

  @Prop({ enum: ['open', 'closed'], default: 'open' })
  status: string;
}

export const RegisterSessionSchema = SchemaFactory.createForClass(RegisterSession);

RegisterSessionSchema.index({ storeId: 1, status: 1 });
RegisterSessionSchema.index({ employeeId: 1 });
RegisterSessionSchema.index({ registerId: 1 });
RegisterSessionSchema.index({ shiftId: 1 });
