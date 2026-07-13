/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SubscriptionCounterDocument = SubscriptionCounter & Document;

/**
 * Atomic sequence counters, scoped by key (e.g. `invoice-202607`). Backs
 * invoice-number generation with a real atomic `$inc` instead of a random
 * suffix, so `invoiceNumber` collisions are structurally impossible rather
 * than merely unlikely.
 */
@Schema({ timestamps: true, collection: 'subscription_counters' })
export class SubscriptionCounter {
  @Prop({ type: String, required: true, unique: true }) _id: string;
  @Prop({ type: Number, required: true, default: 0 }) seq: number;
}

export const SubscriptionCounterSchema = SchemaFactory.createForClass(SubscriptionCounter);
