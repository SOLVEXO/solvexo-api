/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TaxReportDocument = TaxReport & Document;

@Schema({ timestamps: true })
export class TaxReport {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  @Prop({ type: String, enum: ['q1', 'q2', 'q3', 'q4', 'annual'], required: true }) period: string;
  @Prop({ type: Number, required: true }) year: number;
  @Prop({ type: String, default: 'USD' }) currency: string;

  // Date range this report covers
  @Prop({ type: Date, required: true }) fromDate: Date;
  @Prop({ type: Date, required: true }) toDate: Date;

  // Aggregated financials for the period
  @Prop({ type: Number, default: 0 }) totalRevenue: number;
  @Prop({ type: Number, default: 0 }) totalFees: number;
  @Prop({ type: Number, default: 0 }) totalRefunds: number;
  @Prop({ type: Number, default: 0 }) totalPayouts: number;
  @Prop({ type: Number, default: 0 }) netRevenue: number;
  @Prop({ type: Number, default: 0 }) estimatedTax: number;
  @Prop({ type: Number, default: 0 }) transactionCount: number;

  // Optional: Cloudinary PDF URL if generated
  @Prop({ type: String, default: null }) pdfUrl: string | null;
  @Prop({ type: Date, default: null }) generatedAt: Date | null;
}

export const TaxReportSchema = SchemaFactory.createForClass(TaxReport);
TaxReportSchema.index({ storeId: 1, year: -1 });
TaxReportSchema.index({ storeId: 1, year: 1, period: 1, currency: 1 }, { unique: true });
