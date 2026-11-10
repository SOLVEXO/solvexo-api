/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

const OptionSchema = { _id: false, id: { type: String, required: true }, label: { type: String, default: '' }, unit: { type: String, enum: ['week', 'month'], required: true }, count: { type: Number, required: true }, discountPercent: { type: Number, default: 0 } };

/** A "selling plan group" (Shopify): one set of delivery frequencies assigned to products. */
@Schema({ timestamps: true, collection: 'sellingplangroups' })
export class SellingPlanGroup {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true, trim: true, maxlength: 80 }) name: string;
  @Prop({ type: [OptionSchema], default: [] }) options: { id: string; label: string; unit: 'week' | 'month'; count: number; discountPercent: number }[];
  /** Days between subscribing and the FIRST order (0 = order at once). */
  @Prop({ type: Number, default: 0 }) trialDays: number;
  /** Stop after this many orders (null = until cancelled). */
  @Prop({ type: Number, default: null }) maxCycles: number | null;
  @Prop({ type: [String], default: [] }) productIds: string[];
  /** Optional: only these variants of the products. Empty = every variant. */
  @Prop({ type: [String], default: [] }) variantIds: string[];
  @Prop({ type: Number, default: 0 }) shippingAmount: number;
  /** Tax added to each renewal order, as a percent of goods (0 = none). The seller sets it; checkout tax rules do not run for renewals. */
  @Prop({ type: Number, default: 0 }) taxPercent: number;
  @Prop({ type: String, enum: ['active', 'archived'], default: 'active' }) status: 'active' | 'archived';
}
export type SellingPlanGroupDocument = SellingPlanGroup & Document;
export const SellingPlanGroupSchema = SchemaFactory.createForClass(SellingPlanGroup);
SellingPlanGroupSchema.index({ storeId: 1, name: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
SellingPlanGroupSchema.index({ storeId: 1, productIds: 1, status: 1 });

export const CONTRACT_STATUSES = ['active', 'paused', 'cancelled', 'completed'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/** One customer's subscription. Payment mode is `manual` only: each renewal is an unpaid order the buyer pays (transfer / COD). */
@Schema({ timestamps: true, collection: 'subscriptioncontracts' })
export class SubscriptionContract {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) userId: string;
  @Prop({ type: String, required: true }) groupId: string;
  @Prop({ type: String, required: true }) optionId: string;
  /** Terms frozen at subscribe time (a later edit of the plan never changes a running contract, except the buyer picking another frequency). */
  @Prop({ type: { _id: false, name: String, unit: String, count: Number, discountPercent: Number, shippingAmount: Number, taxPercent: Number, maxCycles: { type: Number, default: null } }, required: true })
  terms: { name: string; unit: 'week' | 'month'; count: number; discountPercent: number; shippingAmount: number; taxPercent: number; maxCycles: number | null };
  @Prop({ type: [{ _id: false, productId: String, variantId: String, quantity: Number }], default: [] }) items: { productId: string; variantId: string; quantity: number }[];
  @Prop({ type: Object, required: true }) shippingAddress: { recipientName: string; addressLine1: string; addressLine2?: string; city: string; state?: string; zipCode?: string; phoneNumber: string };
  @Prop({ type: String, default: '' }) customerName: string;
  @Prop({ type: String, default: null }) customerEmail: string | null;
  @Prop({ type: String, enum: ['manual'], default: 'manual' }) paymentMode: 'manual';
  @Prop({ type: String, enum: CONTRACT_STATUSES, default: 'active' }) status: ContractStatus;
  @Prop({ type: Date, required: true }) nextBillingAt: Date;
  @Prop({ type: Number, default: 0 }) cyclesDone: number;
  @Prop({ type: String, default: null }) lastOrderId: string | null;
  @Prop({ type: Date, default: null }) lastOrderAt: Date | null;
  /** Consecutive days a renewal could not be placed for lack of stock (auto-pause at 3). */
  @Prop({ type: Number, default: 0 }) stockFailures: number;
  /** 0 = none sent; 1 = 3-day reminder; 2 = 5-day reminder; 3 = paused for non-payment. */
  @Prop({ type: Number, default: 0 }) dunningStage: number;
  @Prop({ type: String, default: null, maxlength: 200 }) pausedReason: string | null;
  @Prop({ type: Date, default: null }) cancelledAt: Date | null;
}
export type SubscriptionContractDocument = SubscriptionContract & Document;
export const SubscriptionContractSchema = SchemaFactory.createForClass(SubscriptionContract);
SubscriptionContractSchema.index({ storeId: 1, status: 1, nextBillingAt: 1 });
SubscriptionContractSchema.index({ status: 1, nextBillingAt: 1 });
SubscriptionContractSchema.index({ storeId: 1, userId: 1 });

/** One billing cycle of one contract. The unique key is what makes a duplicate renewal impossible. */
@Schema({ timestamps: true, collection: 'subscriptioncycles' })
export class SubscriptionCycle {
  @Prop({ type: String, required: true }) contractId: string;
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: Number, required: true }) cycleNo: number;
  @Prop({ type: String, enum: ['creating', 'ordered'], default: 'creating' }) status: 'creating' | 'ordered';
  @Prop({ type: String, default: null }) orderId: string | null;
  @Prop({ type: Number, default: 0 }) amount: number;
}
export type SubscriptionCycleDocument = SubscriptionCycle & Document;
export const SubscriptionCycleSchema = SchemaFactory.createForClass(SubscriptionCycle);
SubscriptionCycleSchema.index({ contractId: 1, cycleNo: 1 }, { unique: true });
