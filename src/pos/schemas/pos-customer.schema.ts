/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PosCustomerDocument = PosCustomer & Document;
export const POS_REGISTRATION_TYPES = ['registered', 'unregistered'] as const;

/**
 * A customer of the till (G3.3). The directory the cashier searches and adds to at the counter. Phone is the natural key in retail (unique per store when present).
 * D8: the buyer-identity fields FBR integration will need are stored now — name, NTN, CNIC, address, registration type — ALL OPTIONAL: no amount-based or other mandatory rule
 * is assumed until the official FBR documents arrive. A storefront buyer account can be linked (`userId`): then store credit and loyalty follow the buyer across the web and the till.
 */
@Schema({ timestamps: true })
export class PosCustomer {
  @Prop({ type: String, required: true, index: true }) storeId: string;
  @Prop({ type: String, required: true, trim: true, maxlength: 120 }) name: string;
  @Prop({ type: String, default: null }) phone: string | null;
  @Prop({ type: String, default: null }) email: string | null;
  @Prop({ type: String, default: null, maxlength: 300 }) address: string | null;
  /** buyer tax identifiers — optional, free-form (format rules come with the official FBR documents) */
  @Prop({ type: String, default: null, maxlength: 30 }) ntn: string | null;
  @Prop({ type: String, default: null, maxlength: 30 }) cnic: string | null;
  @Prop({ type: String, enum: [...POS_REGISTRATION_TYPES, null], default: null }) registrationType: string | null;
  @Prop({ type: String, default: null, maxlength: 60 }) group: string | null;
  @Prop({ type: String, default: null, maxlength: 500 }) notes: string | null;
  @Prop({ type: Boolean, default: false }) marketingConsent: boolean;
  /** a linked storefront buyer account: credit + loyalty are keyed by it, so they are shared with the web */
  @Prop({ type: String, default: null }) userId: string | null;
  @Prop({ type: String, default: null }) createdBy: string | null;
  @Prop({ type: String, default: 'pos' }) source: string;
  @Prop({ type: Boolean, default: false }) isDelete: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}
export const PosCustomerSchema = SchemaFactory.createForClass(PosCustomer);
PosCustomerSchema.index({ storeId: 1, phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' }, isDelete: false }, name: 'uniq_pos_customer_phone' });
PosCustomerSchema.index({ storeId: 1, name: 1 });
PosCustomerSchema.index({ storeId: 1, userId: 1 }, { sparse: true });
