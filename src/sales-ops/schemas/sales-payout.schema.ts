/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalesPayoutDocument = SalesPayout & Document;

/** Money sent to a partner, settling every payable ledger line up to that moment. */
@Schema({ timestamps: true, collection: 'sales_payouts' })
export class SalesPayout {
  @Prop({ type: String, required: true, index: true }) partnerId: string;
  @Prop({ type: Number, required: true }) amountPKR: number;
  @Prop({ type: String, default: 'bank' }) method: string;
  /** Bank / JazzCash / Easypaisa transaction reference. */
  @Prop({ type: String, default: null }) reference: string | null;
  @Prop({ type: Date, required: true }) paidAt: Date;
  @Prop({ type: [String], default: [] }) commissionIds: string[];
  @Prop({ type: String, default: null }) note: string | null;
  @Prop({ type: String, default: null }) createdByAdminId: string | null;
}

export const SalesPayoutSchema = SchemaFactory.createForClass(SalesPayout);
