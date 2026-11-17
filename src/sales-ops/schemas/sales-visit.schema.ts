/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalesVisitDocument = SalesVisit & Document;

/**
 * One field visit by a sales rep to a shop (Sales Ops → New visit). Every visit belongs to a lead: the first visit to a
 * shop creates it, later visits (same WhatsApp number) join it. Answers are option keys from field-visit.constants.ts.
 */
@Schema({ timestamps: true, collection: 'sales_visits' })
export class SalesVisit {
  /** Made by the phone when the form is saved; a visit synced twice (offline retry) is stored once. */
  @Prop({ type: String, required: true, unique: true }) clientId: string;
  @Prop({ type: String, required: true, index: true }) leadId: string;
  /** The rep who made the visit. */
  @Prop({ type: String, required: true, index: true }) adminId: string;
  /** When the rep saved the form on the phone (may be earlier than createdAt for visits saved offline). */
  @Prop({ type: Date, required: true, index: true }) visitedAt: Date;

  @Prop({ type: String, required: true, trim: true }) storeName: string;
  @Prop({ type: String, required: true, index: true }) storeKey: string;
  @Prop({ type: String, default: null, trim: true }) unit: string | null;
  @Prop({ type: String, default: null }) floor: string | null;
  @Prop({ type: String, default: null, trim: true, index: true }) area: string | null;
  @Prop({ type: Object, default: null }) location: { lat: number; lng: number; accuracyM: number | null } | null;
  @Prop({ type: String, default: null }) photoUrl: string | null;
  @Prop({ type: String, default: null }) photoPublicId: string | null;

  @Prop({ type: String, default: null }) category: string | null;
  @Prop({ type: String, default: null, trim: true }) categoryOther: string | null;
  @Prop({ type: String, default: null }) priceRange: string | null;
  @Prop({ type: String, default: null }) wholesale: string | null;

  @Prop({ type: String, default: null, trim: true }) contactName: string | null;
  @Prop({ type: String, default: null }) contactRole: string | null;
  @Prop({ type: String, default: null, trim: true }) whatsapp: string | null;
  @Prop({ type: String, default: null, index: true }) whatsappKey: string | null;
  @Prop({ type: Boolean, default: false }) waPermission: boolean;
  @Prop({ type: String, default: null }) bestTime: string | null;
  @Prop({ type: String, default: null, trim: true }) instagram: string | null;
  @Prop({ type: String, default: null, trim: true }) facebook: string | null;
  @Prop({ type: String, default: null, trim: true }) website: string | null;

  @Prop({ type: [String], default: [] }) sellsOn: string[];
  @Prop({ type: String, default: null }) ordersPerMonth: string | null;
  @Prop({ type: [String], default: [] }) payments: string[];
  @Prop({ type: [String], default: [] }) couriers: string[];
  @Prop({ type: String, default: null }) courierBooking: string | null;
  @Prop({ type: String, default: null }) billing: string | null;
  @Prop({ type: String, default: null, trim: true }) billingSoftware: string | null;
  @Prop({ type: String, default: null }) khata: string | null;
  @Prop({ type: [String], default: [] }) seasons: string[];
  @Prop({ type: String, default: null, trim: true }) bestSellers: string | null;

  /** In the owner's own words. */
  @Prop({ type: String, default: null, trim: true }) problem: string | null;
  @Prop({ type: [String], default: [] }) problemTags: string[];
  @Prop({ type: [String], default: [] }) objections: string[];
  @Prop({ type: String, required: true, index: true }) interest: string;
  @Prop({ type: String, required: true }) nextStep: string;
  @Prop({ type: Date, default: null }) nextStepAt: Date | null;
  /** The follow-up task the next step created. */
  @Prop({ type: String, default: null }) taskId: string | null;

  @Prop({ type: Boolean, default: false, index: true }) isDelete: boolean;
}

export const SalesVisitSchema = SchemaFactory.createForClass(SalesVisit);
SalesVisitSchema.index({ visitedAt: -1, adminId: 1 });
