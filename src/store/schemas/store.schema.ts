/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StoreDocument = Store & Document;

export enum SellerType {
  CREATOR = 'creator',
  EDUCATOR = 'educator',
  RETAILER = 'retailer',
  BRAND_BUSINESS = 'brand_business',
  FREELANCER = 'freelancer',
  MIX = 'mix',
}

export enum ProductType {
  PHYSICAL_PRODUCTS = 'physical_products',
  DIGITAL_DOWNLOADS = 'digital_downloads',
  EDUCATIONAL_RESOURCES = 'educational_resources',
  SERVICES_BOOKINGS = 'services_bookings',
  SUBSCRIPTIONS = 'subscriptions',
  IN_PERSON_POS = 'in_person_pos',
}

export enum StorePlan {
  STARTER = 'starter',
  BASIC = 'basic',
  PRO = 'pro',
  ENTERPRISE = 'enterprise',
}

export enum StoreTool {
  // physical
  INVENTORY_MANAGER = 'inventory_manager',
  SHIPPING_MANAGER = 'shipping_manager',
  // digital
  DIGITAL_DELIVERY = 'digital_delivery',
  // educational
  EDU_RESOURCE_TOOLS = 'edu_resource_tools',
  AI_WORKSHEET_BUILDER = 'ai_worksheet_builder',
  // services
  BOOKING_CALENDAR = 'booking_calendar',
  // subscriptions
  SUBSCRIPTIONS = 'subscriptions',
  // pos
  POS_REGISTER = 'pos_register',
  // universal (hamesha on)
  AI_STUDIO = 'ai_studio',
  MARKETPLACE_LISTING = 'marketplace_listing',
}

// product type -> uske tools (universal yahan nahi)
export const PRODUCT_TYPE_TOOLS: Record<ProductType, StoreTool[]> = {
  [ProductType.PHYSICAL_PRODUCTS]:     [StoreTool.INVENTORY_MANAGER, StoreTool.SHIPPING_MANAGER],
  [ProductType.DIGITAL_DOWNLOADS]:     [StoreTool.DIGITAL_DELIVERY],
  [ProductType.EDUCATIONAL_RESOURCES]: [StoreTool.EDU_RESOURCE_TOOLS, StoreTool.AI_WORKSHEET_BUILDER],
  [ProductType.SERVICES_BOOKINGS]:     [StoreTool.BOOKING_CALENDAR],
  [ProductType.SUBSCRIPTIONS]:         [StoreTool.SUBSCRIPTIONS],
  [ProductType.IN_PERSON_POS]:         [StoreTool.POS_REGISTER],
};

// ye dono har product type ke saath on rehte hain
export const UNIVERSAL_TOOLS: StoreTool[] = [
  StoreTool.AI_STUDIO,
  StoreTool.MARKETPLACE_LISTING,
];

// selected product types se final tool list nikaalo
export function resolveTools(productTypes: ProductType[]): StoreTool[] {
  const tools = new Set<StoreTool>();
  for (const type of productTypes) {
    PRODUCT_TYPE_TOOLS[type]?.forEach((t) => tools.add(t));
  }
  UNIVERSAL_TOOLS.forEach((t) => tools.add(t));
  return [...tools];
}

@Schema({ _id: true })
export class Register {
  @Prop({ required: true })
  name: string;                 // "Register 1"

  @Prop({ type: Number, default: 100 })
  defaultFloatCash: number;     // shuruaati float

  @Prop({ enum: ['active', 'inactive'], default: 'active' })
  status: string;

  // Which physical branch (StoreLocation) this register belongs to — null
  // means unassigned/legacy (predates multi-location POS), grouped under an
  // "Unassigned" bucket in per-location reports rather than requiring a migration.
  @Prop({ type: String, default: null })
  locationId: string | null;
}
export const RegisterSchema = SchemaFactory.createForClass(Register);

@Schema({ _id: true })
export class Shift {
  @Prop({ required: true })
  name: string;                 // "Morning shift"

  @Prop({ required: true })
  startTime: string;            // "08:00"

  @Prop({ required: true })
  endTime: string;              // "16:00"

  @Prop({ type: [Number], default: [1, 2, 3, 4, 5] })
  daysOfWeek: number[];         // 0=Sun … 6=Sat

  @Prop({ enum: ['active', 'inactive'], default: 'active' })
  status: string;
}
export const ShiftSchema = SchemaFactory.createForClass(Shift);

// Store's own SEO embed — a superset of the shared `SeoMeta` shape (see
// seo/schemas/seo-meta.schema.ts) with two store-only additions: `checklist`
// (Technical Checklist — automated-check results merged with manual
// seller-ticked items at read time by StoreSeoService) and `pages` (per
// page-builder-page meta override, keyed by the page id already present in
// `builderConfig`). Deliberately a separate class rather than extending
// SeoMeta via inheritance — Mongoose subdocument inheritance has enough
// footguns that duplicating ~9 fields is the safer, more readable choice.
@Schema({ _id: false })
export class StoreSeoChecklistItem {
  @Prop({ required: true }) key: string; // e.g. 'https_enabled', 'sitemap_submitted'
  @Prop({ type: Boolean, default: false }) done: boolean;
  @Prop({ type: Date, default: null }) completedAt: Date | null;
}
export const StoreSeoChecklistItemSchema = SchemaFactory.createForClass(StoreSeoChecklistItem);

@Schema({ _id: false })
export class StoreSeo {
  @Prop({ type: String, default: null }) metaTitle: string | null;
  @Prop({ type: String, default: null }) metaDescription: string | null;
  @Prop({ type: String, default: null }) ogImage: string | null;
  @Prop({ type: String, default: null }) ogTitle: string | null;
  @Prop({ type: String, default: null }) ogDescription: string | null;
  @Prop({ type: String, enum: ['summary', 'summary_large_image'], default: 'summary_large_image' })
  twitterCard: string;
  @Prop({ type: String, default: null }) canonicalUrlOverride: string | null;
  @Prop({ type: Boolean, default: false }) noindex: boolean;
  @Prop({ type: [String], default: [] }) keywords: string[];
  @Prop({ type: Boolean, default: false }) aiGenerated: boolean;
  @Prop({ type: Date, default: null }) updatedAt: Date | null;

  @Prop({ type: [StoreSeoChecklistItemSchema], default: [] })
  checklist: StoreSeoChecklistItem[];

  // Record<pageId, seo-meta-shaped object>, stored as a plain Object since
  // builder-config page ids are frontend-generated and open-ended.
  @Prop({ type: Object, default: () => ({}) })
  pages: Record<string, {
    metaTitle?: string | null;
    metaDescription?: string | null;
    ogImage?: string | null;
    noindex?: boolean;
  }>;
}
export const StoreSeoSchema = SchemaFactory.createForClass(StoreSeo);

@Schema({ timestamps: true })
export class Store {
  @Prop({ required: true })
  sellerId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, unique: true })
  slug: string;

  @Prop({ type: String, default: null })
  logo: string | null;

  @Prop({ type: String, default: null })
  categoryId!: string | null;

  @Prop({ type: String, default: null })
  description!: string | null;

  @Prop({
    type: String,
    enum: Object.values(SellerType),
    default: null,
  })
  sellerType!: SellerType | null;

  @Prop({
    type: [String],
    enum: Object.values(ProductType),
    default: [],
  })
  productTypes!: ProductType[];

  @Prop({
    type: [String],
    enum: Object.values(StoreTool),
    default: [],
  })
  enabledTools!: StoreTool[];

  @Prop({
    type: String,
    enum: Object.values(StorePlan),
    default: StorePlan.STARTER,
  })
  plan!: StorePlan;

  @Prop({ type: Number, default: 100 })
  aiCredits!: number;

  @Prop({ type: [RegisterSchema], default: [] })
  registers: Register[];

  @Prop({ type: [ShiftSchema], default: [] })
  shifts: Shift[];

  @Prop({ type: Object, default: null })
  builderConfig: Record<string, any> | null;

  @Prop({ type: String, default: null })
  coverImage: string | null;

  // Platform-plan-gated features (see EntitlementsService) — dedicated fields
  // rather than buried inside the opaque `builderConfig` blob, so backend
  // enforcement doesn't depend on parsing arbitrary frontend-owned JSON.
  @Prop({ type: String, default: null })
  customDomain: string | null;

  @Prop({ type: Boolean, default: false })
  whiteLabelEnabled: boolean;

  @Prop({ type: Number, default: 0 })
  followersCount: number;

  // Persisted rollup from Rating docs (storeId-scoped) — recalculated by
  // RatingService.recalcStoreRating(), same pattern as Product.averageRating.
  @Prop({ type: Number, default: 0 })
  averageRating: number;

  @Prop({ type: Number, default: 0 })
  reviewCount: number;

  @Prop({ enum: ['active', 'inactive', 'suspended'], default: 'active' })
  status: string;

  // admin-granted badges, e.g. ['top_seller', 'verified', 'featured', 'verified_educator']
  @Prop({ type: [String], default: [] })
  badges: string[];

  @Prop({ default: false })
  isDelete: boolean;

  @Prop({ type: StoreSeoSchema, default: () => ({}) })
  seo: StoreSeo;
}

export const StoreSchema = SchemaFactory.createForClass(Store);

StoreSchema.index({ sellerId: 1 });
StoreSchema.index({ slug: 1 });
StoreSchema.index({ name: 1 });
StoreSchema.index({ sellerType: 1 });
StoreSchema.index({ averageRating: -1 });
StoreSchema.index({ followersCount: -1 });