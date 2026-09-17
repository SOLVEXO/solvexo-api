/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DraftOrderDocument = HydratedDocument<DraftOrder>;

@Schema({ _id: true })
export class DraftOrderItem {
  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ type: String, required: true })
  variantId: string;

  @Prop({ type: String, enum: ['physical', 'digital'], required: true })
  type: string;

  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String, default: null })
  image: string | null;

  @Prop({ type: String, default: null })
  sku: string | null;

  @Prop({ type: [{ name: String, value: String }], default: [] })
  options: { name: string; value: string }[];

  @Prop({ required: true })
  quantity: number;

  // The price the seller is charging on THIS draft order — defaults to the
  // variant's current price at add-time but is explicitly editable (a
  // manually-created order routinely needs a one-off price: a wholesale
  // deal, a goodwill discount, a phone-order negotiated price). Never
  // silently re-derived from the live product price later.
  @Prop({ required: true })
  unitPrice: number;
}

export const DraftOrderItemSchema = SchemaFactory.createForClass(DraftOrderItem);

@Schema({ timestamps: true })
export class DraftOrder {
  @Prop({ type: String, required: true, index: true })
  storeId: string;

  @Prop({ type: String, required: true })
  sellerId: string;

  // Set only once a real registered buyer account is attached — required to
  // actually convert this draft into a real `Order` (`Order.userId` is a
  // hard, non-nullable foreign key on that schema; a purely "guest" draft
  // can be built, priced, and sent as an invoice, but genuinely cannot
  // become a real Order until a registered account is linked). This is a
  // real, disclosed architectural boundary, not an oversight.
  @Prop({ type: String, default: null })
  customerId: string | null;

  @Prop({ type: String, required: true })
  customerName: string;

  @Prop({ type: String, default: null })
  customerEmail: string | null;

  @Prop({ type: String, default: null })
  customerPhone: string | null;

  @Prop({ type: [DraftOrderItemSchema], default: [] })
  items: DraftOrderItem[];

  @Prop({ type: String, enum: ['percentage', 'fixed', null], default: null })
  discountType: 'percentage' | 'fixed' | null;

  @Prop({ type: Number, default: 0 })
  discountValue: number;

  @Prop({ type: Number, default: 0 })
  shippingAmount: number;

  @Prop({ type: Number, default: 0 })
  taxAmount: number;

  @Prop({ type: String, default: '' })
  notes: string;

  // Always the store's own baseCurrency — a manually-priced merchant order
  // has no buyer-currency-preference concept to resolve.
  @Prop({ type: String, required: true })
  currency: string;

  // Denormalized/cached on every save (DraftOrdersService.recalculate) so
  // list views never need to recompute from `items` client-side.
  @Prop({ type: Number, default: 0 })
  subtotal: number;

  @Prop({ type: Number, default: 0 })
  discountAmount: number;

  @Prop({ type: Number, default: 0 })
  total: number;

  @Prop({ type: String, enum: ['open', 'completed', 'cancelled'], default: 'open' })
  status: 'open' | 'completed' | 'cancelled';

  // Set once `complete()` successfully converts this draft into a real Order.
  @Prop({ type: String, default: null })
  orderId: string | null;

  @Prop({ type: String, default: null })
  orderNumber: string | null;

  @Prop({ type: Date, default: null })
  completedAt: Date | null;

  @Prop({ type: Date, default: null })
  cancelledAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const DraftOrderSchema = SchemaFactory.createForClass(DraftOrder);

DraftOrderSchema.index({ storeId: 1, status: 1, createdAt: -1 });
