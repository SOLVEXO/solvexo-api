/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TransactionDocument = Transaction & Document;

@Schema({ timestamps: true })
export class Transaction {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  // Type of financial event
  @Prop({
    type: String,
    enum: ['sale', 'payout', 'fee', 'refund', 'adjustment'],
    required: true,
  })
  type: string;

  // Positive = credit, negative = debit
  @Prop({ type: Number, required: true }) amount: number;
  @Prop({ type: Number, required: true }) balanceBefore: number;
  @Prop({ type: Number, required: true }) balanceAfter: number;

  // Human-readable description shown in transaction history
  @Prop({ type: String, required: true }) description: string;

  // Reference to the source document (orderId, payoutId, etc.)
  @Prop({ type: String, default: null }) referenceId: string | null;
  @Prop({
    type: String,
    enum: ['order', 'payout', 'manual', null],
    default: null,
  })
  referenceType: string | null;

  @Prop({
    type: String,
    enum: ['completed', 'pending', 'failed'],
    default: 'completed',
  })
  status: string;

  // Extra metadata (fee breakdown, order items count, etc.)
  @Prop({ type: Object, default: null }) metadata: Record<string, any> | null;
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);
TransactionSchema.index({ storeId: 1, createdAt: -1 });
TransactionSchema.index({ storeId: 1, type: 1, createdAt: -1 });
TransactionSchema.index({ referenceId: 1 });
