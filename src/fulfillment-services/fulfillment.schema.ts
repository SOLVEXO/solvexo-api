/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/** A third-party fulfilment service (3PL / warehouse) connected to ONE store. Owns one StoreLocation. */
@Schema({ timestamps: true, collection: 'fulfillmentservices' })
export class FulfillmentService {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true, trim: true, maxlength: 80 }) name: string;
  @Prop({ type: String, enum: ['generic_http', 'mock'], required: true }) provider: 'generic_http' | 'mock';
  /** generic_http only: the https endpoint that receives signed fulfilment requests. */
  @Prop({ type: String, default: null, maxlength: 500 }) endpointUrl: string | null;
  /** AES-GCM copy of the shared secret (signs requests we send AND the callbacks we accept). Never returned. */
  @Prop({ type: String, required: true, select: false }) secretEnc: string;
  @Prop({ type: String, default: '' }) secretHint: string;
  @Prop({ type: String, enum: ['active', 'disabled'], default: 'active' }) status: 'active' | 'disabled';
  /** The location this service owns (stock it reports lands here). */
  @Prop({ type: String, default: null }) locationId: string | null;
  /** Send new PAID orders automatically (only physical lines of this store). */
  @Prop({ type: Boolean, default: false }) autoRoute: boolean;
  @Prop({ type: Boolean, default: true }) trackInventory: boolean;
  @Prop({ type: Date, default: null }) lastCallbackAt: Date | null;
  @Prop({ type: Boolean, default: false }) isDelete: boolean;
}
export type FulfillmentServiceDocument = FulfillmentService & Document;
export const FulfillmentServiceSchema = SchemaFactory.createForClass(FulfillmentService);
FulfillmentServiceSchema.index({ storeId: 1, name: 1 }, { unique: true, partialFilterExpression: { isDelete: false } });

export const REQUEST_STATUSES = ['pending', 'sent', 'accepted', 'shipped', 'delivered', 'cancelled', 'failed'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** One order handed to one service. Unique per (store, order, service): routing twice is a no-op. */
@Schema({ timestamps: true, collection: 'fulfillmentrequests' })
export class FulfillmentRequest {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) serviceId: string;
  @Prop({ type: String, required: true }) orderId: string;
  @Prop({ type: String, default: '' }) orderNumber: string;
  @Prop({ type: [{ _id: false, itemId: String, variantId: { type: String, default: null }, sku: { type: String, default: null }, title: { type: String, default: '' }, quantity: Number }], default: [] })
  items: { itemId: string; variantId: string | null; sku: string | null; title: string; quantity: number }[];
  @Prop({ type: String, enum: REQUEST_STATUSES, default: 'pending' }) status: RequestStatus;
  @Prop({ type: Number, default: 0 }) attempts: number;
  @Prop({ type: String, default: null, maxlength: 300 }) lastError: string | null;
  @Prop({ type: String, default: null, maxlength: 120 }) externalId: string | null;
  @Prop({ type: { _id: false, carrier: { type: String, default: null }, trackingNumber: { type: String, default: null }, trackingUrl: { type: String, default: null } }, default: null })
  tracking: { carrier: string | null; trackingNumber: string | null; trackingUrl: string | null } | null;
  /** Callback event ids already applied (idempotency). */
  @Prop({ type: [String], default: [] }) eventIds: string[];
  @Prop({ type: Date, default: null }) sentAt: Date | null;
}
export type FulfillmentRequestDocument = FulfillmentRequest & Document;
export const FulfillmentRequestSchema = SchemaFactory.createForClass(FulfillmentRequest);
FulfillmentRequestSchema.index({ storeId: 1, orderId: 1, serviceId: 1 }, { unique: true });
FulfillmentRequestSchema.index({ storeId: 1, status: 1, createdAt: -1 });
FulfillmentRequestSchema.index({ serviceId: 1, status: 1 });
