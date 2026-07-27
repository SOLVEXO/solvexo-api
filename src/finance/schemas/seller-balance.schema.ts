import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SellerBalanceDocument = SellerBalance & Document;

@Schema({ timestamps: true })
export class SellerBalance {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  // Funds available for immediate payout
  @Prop({ type: Number, default: 0 }) availableBalance: number;
  // Funds from recent sales still in clearing period (3 days)
  @Prop({ type: Number, default: 0 }) pendingBalance: number;

  // Lifetime totals
  @Prop({ type: Number, default: 0 }) totalRevenue: number;
  @Prop({ type: Number, default: 0 }) totalFees: number;
  @Prop({ type: Number, default: 0 }) totalRefunds: number;
  @Prop({ type: Number, default: 0 }) totalPayouts: number;

  @Prop({ type: String, default: 'USD' }) currency: string;
}

export const SellerBalanceSchema = SchemaFactory.createForClass(SellerBalance);
SellerBalanceSchema.index({ storeId: 1 }, { unique: true });
SellerBalanceSchema.index({ sellerId: 1 });
