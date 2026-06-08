/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SaleDocument = Sale & Document;

@Schema({ _id: false })
export class SaleItem {
  @Prop({ required: true })
  productId: string;

  @Prop({ required: true })
  variantId: string;            // asli bikne wali cheez (price/stock isi pe)

  @Prop({ required: true })
  name: string;                 // snapshot — "Ceramic Mug (Blue)"

  @Prop({ required: true })
  sku: string;                  // variant ka sku — "MUG-001"

  @Prop({ type: Number, required: true })
  price: number;                // snapshot — bikri ke waqt ki keemat

  @Prop({ type: Number, required: true })
  qty: number;

  @Prop({ type: Number, required: true })
  lineTotal: number;            // price × qty
}
export const SaleItemSchema = SchemaFactory.createForClass(SaleItem);

@Schema({ timestamps: true })
export class Sale {
  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true })
  sessionId: string;            // kis register session me — shift report isi se

  @Prop({ required: true })
  registerId: string;

  @Prop({ required: true })
  employeeId: string;           // kis cashier ne bechi

  @Prop({ type: [SaleItemSchema], default: [] })
  items: SaleItem[];

  @Prop({ type: Number, default: 0 })
  subtotal: number;

  @Prop({ type: Number, default: 0 })
  discount: number;

  @Prop({ type: Number, default: 0 })
  tax: number;

  @Prop({ type: Number, required: true })
  total: number;

  @Prop({ enum: ['cash', 'card', 'other'], default: 'cash' })
  paymentMethod: string;

  @Prop({ default: null })
  customerId: string;           // optional — Walk-in pe null

  @Prop({ default: 'Walk-in' })
  customerName: string;         // "Walk-in", "Sarah M."

  @Prop({ enum: ['completed', 'held', 'refunded'], default: 'completed' })
  status: string;               // "Hold Current Sale" → held
}

export const SaleSchema = SchemaFactory.createForClass(Sale);

SaleSchema.index({ storeId: 1, createdAt: -1 });
SaleSchema.index({ sessionId: 1 });
SaleSchema.index({ employeeId: 1 });
SaleSchema.index({ 'items.variantId': 1 });