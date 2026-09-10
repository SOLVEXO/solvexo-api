import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type GiftCardTransactionDocument = GiftCardTransaction & Document;

/** Audit ledger for a GiftCard's balance — same convention as LoyaltyTransaction. */
@Schema({ timestamps: true })
export class GiftCardTransaction {
  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true })
  giftCardId: string;

  @Prop({ required: true, enum: ['issue', 'redeem', 'refund'] })
  type: 'issue' | 'redeem' | 'refund';

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  balanceAfter: number;

  @Prop({ type: String, default: null })
  checkoutId: string | null;

  @Prop({ type: String, default: null })
  orderId: string | null;

  @Prop({ type: String, default: null })
  description: string | null;
}

export const GiftCardTransactionSchema = SchemaFactory.createForClass(GiftCardTransaction);

GiftCardTransactionSchema.index({ giftCardId: 1, createdAt: -1 });
GiftCardTransactionSchema.index({ storeId: 1 });
