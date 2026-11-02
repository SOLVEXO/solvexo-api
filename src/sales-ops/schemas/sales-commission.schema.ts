/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalesCommissionDocument = SalesCommission & Document;

/**
 * One line in a partner's commission ledger. Lines are never edited: a refund or correction is a new
 * `adjustment` line (negative when money is taken back). `key` makes writing them idempotent.
 */
@Schema({ timestamps: true, collection: 'sales_commissions' })
export class SalesCommission {
  @Prop({ type: String, required: true, index: true }) partnerId: string;
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, default: null }) storeId: string | null;
  @Prop({ type: String, default: null, index: true }) invoiceId: string | null;
  @Prop({
    type: String,
    enum: ['bounty', 'percent', 'adjustment'],
    required: true,
  })
  type: string;
  /** Unique per partner: bounty:<sellerId>, pct:<invoiceId>, pct:<invoiceId>:adj:<n>, manual:<id>. */
  @Prop({ type: String, required: true }) key: string;
  @Prop({ type: String, default: null }) description: string | null;
  @Prop({ type: Number, default: 0 }) basisUSD: number;
  @Prop({ type: Number, default: null }) pkrPerUSD: number | null;
  @Prop({ type: Number, default: null }) percent: number | null;
  @Prop({ type: Number, required: true }) amountPKR: number;
  @Prop({ type: Date, required: true, index: true }) earnedAt: Date;
  @Prop({ type: Date, required: true }) payableAt: Date;
  @Prop({
    type: String,
    enum: ['pending', 'payable', 'paid', 'void'],
    default: 'pending',
    index: true,
  })
  status: string;
  @Prop({ type: String, default: null }) payoutId: string | null;
  @Prop({ type: String, default: null }) createdByAdminId: string | null;
}

export const SalesCommissionSchema =
  SchemaFactory.createForClass(SalesCommission);
SalesCommissionSchema.index({ partnerId: 1, key: 1 }, { unique: true });
