import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PayoutDocument = Payout & Document;

@Schema({ timestamps: true })
export class Payout {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  @Prop({ type: Number, required: true }) amount: number;
  @Prop({ type: String, default: 'USD' }) currency: string;

  @Prop({ type: String, required: true }) payoutMethodId: string;
  // Snapshot of the method at time of payout (in case method is later deleted)
  @Prop({ type: Object, default: null }) payoutMethodSnapshot: {
    type: string;
    bankName: string | null;
    accountLast4: string;
  } | null;

  @Prop({
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending',
  })
  status: string;

  // Distinguishes a seller-tapped "Withdraw" from one the scheduled batch job
  // created on the seller's behalf (see FinanceService.processScheduledPayouts)
  // — both flow through the same admin approve/reject queue, but admins and
  // sellers alike benefit from seeing which is which.
  @Prop({ type: String, enum: ['seller_manual', 'scheduled_auto'], default: 'seller_manual' })
  source: string;

  @Prop({ type: Date, default: null }) scheduledAt: Date | null;
  @Prop({ type: Date, default: null }) processedAt: Date | null;
  @Prop({ type: String, default: null }) failureReason: string | null;
  @Prop({ type: String, default: null }) notes: string | null;

  // Reference transaction ID after processing
  @Prop({ type: String, default: null }) transactionId: string | null;
}

export const PayoutSchema = SchemaFactory.createForClass(Payout);
PayoutSchema.index({ storeId: 1, createdAt: -1 });
PayoutSchema.index({ storeId: 1, status: 1 });
PayoutSchema.index({ sellerId: 1 });
