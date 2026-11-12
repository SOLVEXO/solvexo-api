/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

/** Every B2B record is store-scoped (`storeId`, string) and never shared across stores. Solvexo holds no money: terms/balances are seller records. */

const AddressShape = {
  recipientName: String, phoneNumber: String, addressLine1: String, addressLine2: String, city: String, state: String, zipCode: String, country: String, _id: false,
};
// The terms object has a field literally named "type", so the sub-schema uses a different typeKey.
const TermsShape = new MongooseSchema({ type: { $type: String, enum: ['due_on_order', 'net', 'due_on_fulfilment'] }, netDays: Number }, { _id: false, typeKey: '$type' });

@Schema({ timestamps: true, collection: 'b2bcompanies' })
export class B2BCompany {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true, trim: true, maxlength: 120 }) name: string;
  @Prop({ type: String, enum: ['pending', 'approved', 'rejected', 'suspended'], default: 'approved' }) status: string;
  @Prop({ type: String, default: null, maxlength: 60 }) taxId: string | null;
  @Prop({ type: Boolean, default: false }) taxExempt: boolean;
  @Prop({ type: String, default: null }) catalogId: string | null;
  @Prop({ type: TermsShape, default: null }) paymentTerms: { type: string; netDays?: number } | null;
  /** Empty = every method the store offers. */
  @Prop({ type: [String], default: [] }) allowedPaymentMethods: string[];
  @Prop({ type: Number, default: null, min: 0 }) creditLimit: number | null;
  /** Percent of an order that must be recorded as received before it ships (0 = none). */
  @Prop({ type: Number, default: 0, min: 0, max: 100 }) depositPercent: number;
  @Prop({ type: String, default: null, maxlength: 500 }) note: string | null;
  @Prop({ type: Boolean, default: false }) isDelete: boolean;
}
export type B2BCompanyDocument = B2BCompany & Document;
export const B2BCompanySchema = SchemaFactory.createForClass(B2BCompany);
B2BCompanySchema.index({ storeId: 1, status: 1, isDelete: 1 });
B2BCompanySchema.index({ storeId: 1, name: 1 }, { unique: true, partialFilterExpression: { isDelete: false } });

@Schema({ timestamps: true, collection: 'b2blocations' })
export class B2BLocation {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) companyId: string;
  @Prop({ required: true, trim: true, maxlength: 120 }) name: string;
  @Prop({ type: AddressShape, default: null }) shippingAddress: Record<string, any> | null;
  @Prop({ type: AddressShape, default: null }) billingAddress: Record<string, any> | null;
  // Overrides: null / empty = follow the company.
  @Prop({ type: String, default: null }) catalogId: string | null;
  @Prop({ type: TermsShape, default: null }) paymentTerms: { type: string; netDays?: number } | null;
  @Prop({ type: [String], default: [] }) allowedPaymentMethods: string[];
  @Prop({ type: Number, default: null, min: 0 }) creditLimit: number | null;
  @Prop({ type: Boolean, default: false }) isDelete: boolean;
}
export type B2BLocationDocument = B2BLocation & Document;
export const B2BLocationSchema = SchemaFactory.createForClass(B2BLocation);
B2BLocationSchema.index({ storeId: 1, companyId: 1, isDelete: 1 });

/** A storefront customer (User row of THIS store) who buys for a company location. */
@Schema({ timestamps: true, collection: 'b2bbuyers' })
export class B2BBuyer {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) companyId: string;
  @Prop({ required: true }) locationId: string;
  @Prop({ required: true }) userId: string;
  @Prop({ type: String, required: true, lowercase: true, trim: true }) email: string;
  @Prop({ type: String, enum: ['ordering', 'location_admin'], default: 'ordering' }) role: string;
  @Prop({ type: String, enum: ['active', 'disabled'], default: 'active' }) status: string;
}
export type B2BBuyerDocument = B2BBuyer & Document;
export const B2BBuyerSchema = SchemaFactory.createForClass(B2BBuyer);
// One user is a buyer of at most one location per store (keeps pricing/terms unambiguous).
B2BBuyerSchema.index({ storeId: 1, userId: 1 }, { unique: true });
B2BBuyerSchema.index({ storeId: 1, companyId: 1, locationId: 1 });

@Schema({ timestamps: true, collection: 'b2bapplications' })
export class B2BApplication {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) userId: string;
  @Prop({ type: String, required: true, lowercase: true, trim: true }) email: string;
  @Prop({ required: true, trim: true, maxlength: 120 }) companyName: string;
  @Prop({ type: String, default: null, maxlength: 60 }) taxId: string | null;
  @Prop({ type: String, default: null, maxlength: 40 }) phone: string | null;
  @Prop({ type: String, default: null, maxlength: 1000 }) message: string | null;
  @Prop({ type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }) status: string;
  @Prop({ type: String, default: null, maxlength: 500 }) decisionNote: string | null;
  @Prop({ type: String, default: null }) companyId: string | null;
  @Prop({ type: Date, default: null }) decidedAt: Date | null;
}
export type B2BApplicationDocument = B2BApplication & Document;
export const B2BApplicationSchema = SchemaFactory.createForClass(B2BApplication);
// One open application per customer per store.
B2BApplicationSchema.index({ storeId: 1, userId: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
B2BApplicationSchema.index({ storeId: 1, status: 1, createdAt: -1 });

@Schema({ timestamps: true, collection: 'b2bcatalogs' })
export class B2BCatalog {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true, trim: true, maxlength: 120 }) name: string;
  @Prop({ type: String, enum: ['active', 'draft'], default: 'active' }) status: string;
  /** Applied to variants that are in the catalog but have neither a fixed price nor their own percentage. */
  @Prop({ type: Number, default: null, min: -100, max: 1000 }) defaultAdjustmentPercent: number | null;
  /** true = every active product is available unless an item says otherwise; false = only listed items are available. */
  @Prop({ type: Boolean, default: false }) includeAllProducts: boolean;
  @Prop({ type: Boolean, default: false }) isDelete: boolean;
}
export type B2BCatalogDocument = B2BCatalog & Document;
export const B2BCatalogSchema = SchemaFactory.createForClass(B2BCatalog);
B2BCatalogSchema.index({ storeId: 1, name: 1 }, { unique: true, partialFilterExpression: { isDelete: false } });

@Schema({ timestamps: true, collection: 'b2bcatalogitems' })
export class B2BCatalogItem {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) catalogId: string;
  @Prop({ required: true }) productId: string;
  @Prop({ required: true }) variantId: string;
  @Prop({ type: Boolean, default: true }) available: boolean;
  @Prop({ type: Number, default: null, min: 0 }) fixedPrice: number | null;
  @Prop({ type: Number, default: null, min: -100, max: 1000 }) adjustmentPercent: number | null;
  @Prop({ type: Number, default: null, min: 1 }) minQty: number | null;
  @Prop({ type: Number, default: null, min: 1 }) maxQty: number | null;
  @Prop({ type: Number, default: null, min: 1 }) increment: number | null;
  @Prop({ type: [{ minQty: Number, price: Number, _id: false }], default: [] }) priceBreaks: { minQty: number; price: number }[];
}
export type B2BCatalogItemDocument = B2BCatalogItem & Document;
export const B2BCatalogItemSchema = SchemaFactory.createForClass(B2BCatalogItem);
B2BCatalogItemSchema.index({ storeId: 1, catalogId: 1, variantId: 1 }, { unique: true });
B2BCatalogItemSchema.index({ storeId: 1, variantId: 1 });
