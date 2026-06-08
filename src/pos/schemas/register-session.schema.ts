/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RegisterSessionDocument = RegisterSession & Document;

@Schema({ timestamps: true })
export class RegisterSession {
  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true })
  registerId: string;           // store.registers ka _id

  @Prop({ required: true })
  employeeId: string;           // kisne khola

  @Prop({ default: null })
  shiftId: string;              // store.shifts ka _id

  @Prop({ required: true })
  openedAt: Date;

  @Prop({ default: null })
  closedAt: Date;

  @Prop({ type: Number, default: 0 })
  openingCash: number;          // float (jaise 100)

  @Prop({ type: Number, default: null })
  closingCash: number;          // band karte waqt asal ginti

  @Prop({ type: Number, default: 0 })
  expectedCash: number;         // openingCash + cashSales

  @Prop({ type: Number, default: 0 })
  cashDifference: number;       // closingCash − expectedCash

  @Prop({ type: Number, default: 0 })
  cashSales: number;            // is session me cash se kitna

  @Prop({ type: Number, default: 0 })
  cardSales: number;            // card se kitna

  @Prop({ type: Number, default: 0 })
  totalSales: number;           // total bikri

  @Prop({ type: Number, default: 0 })
  totalTransactions: number;    // kitni bikriyaan

  @Prop({ enum: ['open', 'closed'], default: 'open' })
  status: string;
}

export const RegisterSessionSchema = SchemaFactory.createForClass(RegisterSession);

RegisterSessionSchema.index({ storeId: 1, status: 1 });
RegisterSessionSchema.index({ employeeId: 1 });
RegisterSessionSchema.index({ registerId: 1 });
RegisterSessionSchema.index({ shiftId: 1 });