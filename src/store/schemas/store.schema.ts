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

  // A seller's own custom `robots.txt` body for their storefront (e.g.
  // blocking `/search` from being indexed, adding a crawl-delay). Null/empty
  // means "use the generated default" — see `StoreService.getPublicStoreRobotsTxt`.
  // Free text, not machine-validated beyond a length cap — a malformed line
  // only affects that seller's own store's crawling, never another store's.
  @Prop({ type: String, default: null, maxlength: 5000 })
  robotsTxtOverride: string | null;
}
export const StoreSeoSchema = SchemaFactory.createForClass(StoreSeo);

export const STORE_ANNOUNCEMENT_TYPES = ['info', 'sale', 'coupon', 'warning', 'shipping', 'holiday'] as const;
export type StoreAnnouncementType = (typeof STORE_ANNOUNCEMENT_TYPES)[number];

// Seller-controlled dismissible bar on their own storefront — distinct from the
// admin-managed platform-wide `Announcement` (comman/ui `AnnouncementBanner`).
@Schema({ _id: false })
export class StoreAnnouncementBar {
  @Prop({ type: String, default: null }) message: string | null;
  @Prop({ type: String, enum: STORE_ANNOUNCEMENT_TYPES, default: 'info' })
  type: StoreAnnouncementType;
  @Prop({ type: String, default: null }) ctaLabel: string | null;
  @Prop({ type: String, default: null }) ctaLink: string | null;
  @Prop({ type: Boolean, default: false }) isActive: boolean;
  @Prop({ type: Date, default: null }) startAt: Date | null;
  @Prop({ type: Date, default: null }) endAt: Date | null;
}
export const StoreAnnouncementBarSchema = SchemaFactory.createForClass(StoreAnnouncementBar);

// Solvexo's own single POS app (Android, for now — already built and
// published). Unlike the white-label StoreAppRequest below, there's nothing
// to build per seller and nothing for our backend to gate: POS is a paid
// Google Play listing, so Google Play collects payment directly when a
// merchant installs it. The dashboard only ever shows a QR/link to that
// listing (see StoreService.getPosAppInfo) — no PaymentIntent, no per-store
// "enabled" flag, nothing tracked here.

// ── Seller business verification (KYC-style Leads review) ──────────────────
// Three genuinely separate concepts, each its own field — never collapsed
// into one status string (see verification-requirements.config.ts for why):
//   Store.status          — marketplace listing lifecycle (is it live?)
//   Store.verificationStatus — where the KYC review itself stands
//   Store.verificationLevel  — which requirement set applies (server-derived
//                              from businessType, never client-supplied)
export const BUSINESS_TYPES = ['individual', 'company', 'partnership'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const ID_DOCUMENT_TYPES = ['cnic', 'passport', 'national_id'] as const;
export type IdDocumentType = (typeof ID_DOCUMENT_TYPES)[number];

export const VERIFICATION_STATUSES = ['not_started', 'pending', 'under_review', 'verified', 'rejected'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const VERIFICATION_LEVELS = ['basic', 'business', 'enhanced'] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

// Valid forward transitions — a rejected submission must go back through
// `pending` (resubmit) rather than jumping straight to `verified`, and a
// fresh store can't be marked `verified` without ever having submitted.
const VERIFICATION_TRANSITIONS: Record<VerificationStatus, VerificationStatus[]> = {
  not_started: ['pending'],
  pending: ['under_review', 'verified', 'rejected'],
  under_review: ['verified', 'rejected'],
  verified: [],
  rejected: ['pending'],
};
export function assertValidVerificationTransition(from: VerificationStatus, to: VerificationStatus) {
  if (from === to) return; // idempotent no-ops (e.g. marking under_review twice) are fine
  if (!VERIFICATION_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Invalid verification transition: ${from} -> ${to}`);
  }
}

// businessType determines the applicable level today — 'enhanced' is
// architecturally supported (see verification-requirements.config.ts) but
// nothing in Solvexo's real business rules assigns it yet, so it's never
// auto-selected. This is a pure function of server-known data, never a
// client-supplied value, per the "backend is the source of truth" rule.
export function determineVerificationLevel(businessType: BusinessType | null): VerificationLevel {
  return businessType === 'company' || businessType === 'partnership' ? 'business' : 'basic';
}

// One row per uploaded document. `publicId`/`resourceType` (never a bare
// `url`) is deliberate — these are sensitive documents (ID, tax certs), so
// they're stored via UploadService.uploadPrivateFile (Cloudinary `type:
// 'private'`), which returns no directly-usable URL at all. Viewing one
// always goes through UploadService.generateSignedUrl at request time
// (short-lived, admin/owner-only) — never a permanent public URL.
export const VERIFICATION_DOCUMENT_TYPES = [
  'business_registration', // Business registration/license
  'tax_registration',      // Tax/NTN registration certificate
  'address_proof',         // Proof of business address
  'owner_id',              // Government ID/passport/CNIC of the owner or authorized rep
  'authorization_proof',   // Authorization/ownership proof (e.g. rep isn't the owner)
] as const;
export type VerificationDocumentType = (typeof VERIFICATION_DOCUMENT_TYPES)[number];

@Schema({ _id: false })
export class VerificationDocument {
  @Prop({ type: String, enum: VERIFICATION_DOCUMENT_TYPES, required: true })
  type: VerificationDocumentType;
  @Prop({ required: true }) publicId: string;
  @Prop({ type: String, default: 'raw' }) resourceType: string;
  @Prop({ required: true }) fileName: string;
  @Prop({ type: Date, default: () => new Date() }) uploadedAt: Date;
}
export const VerificationDocumentSchema = SchemaFactory.createForClass(VerificationDocument);

// Audit trail — every submit/resubmit/under-review/approve/reject event,
// surfaced to both the seller (their own timeline) and admin (review
// history) rather than only existing in the general ActivityLog stream.
@Schema({ _id: false })
export class VerificationHistoryEntry {
  @Prop({ required: true }) action: string; // 'submitted' | 'resubmitted' | 'under_review' | 'approved' | 'rejected'
  @Prop({ type: String, default: null }) note: string | null;
  @Prop({ type: String, default: null }) actorId: string | null;
  @Prop({ type: String, enum: ['seller', 'admin'], default: 'seller' }) actorRole: string;
  @Prop({ type: Date, default: () => new Date() }) at: Date;
}
export const VerificationHistoryEntrySchema = SchemaFactory.createForClass(VerificationHistoryEntry);

@Schema({ _id: false })
export class AuthorizedContact {
  @Prop({ type: String, default: null }) name: string | null;
  @Prop({ type: String, default: null }) designation: string | null;
  @Prop({ type: String, default: null }) email: string | null;
  @Prop({ type: String, default: null }) phone: string | null;
}
export const AuthorizedContactSchema = SchemaFactory.createForClass(AuthorizedContact);

@Schema({ _id: false })
export class SellerVerification {
  // NOT here — `businessType` lives on `Store` itself (top-level, see
  // below), alongside `country`/`verificationLevel`/`verificationStatus`.
  // Those four are the classification/state fields requirement-calculation
  // and admin-list views need cheaply; everything below is the actual
  // sensitive submission data, which is why this whole subdocument stays
  // `select: false` on the parent Store schema.
  @Prop({ type: String, default: null }) legalBusinessName: string | null;
  @Prop({ type: String, default: null }) registrationNumber: string | null;
  @Prop({ type: String, default: null }) taxId: string | null;
  @Prop({ type: String, default: null }) businessAddress: string | null;
  @Prop({ type: String, enum: ID_DOCUMENT_TYPES, default: null }) idDocumentType: IdDocumentType | null;
  @Prop({ type: AuthorizedContactSchema, default: () => ({}) }) authorizedContact: AuthorizedContact;
  @Prop({ type: [VerificationDocumentSchema], default: [] }) documents: VerificationDocument[];
  @Prop({ type: [VerificationHistoryEntrySchema], default: [] }) history: VerificationHistoryEntry[];
  // Flips true the first time the seller submits (vs. still drafting during
  // onboarding) — lets the admin Leads list distinguish "seller hasn't
  // finished yet" from "ready to review" without inspecting every field.
  @Prop({ type: Boolean, default: false }) submitted: boolean;
}
export const SellerVerificationSchema = SchemaFactory.createForClass(SellerVerification);
// Required-document/field calculation lives in verification-requirements.config.ts
// (centralized, country + businessType + level aware) — not here.

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

  // The currency this seller prices their products in — chosen once at
  // store creation (StoreService.createStore), suggested from the seller's
  // detected country but never forced. Locked immutable the moment this
  // store has its first product (enforced in service layer, not here) to
  // prevent a price number silently being reinterpreted under a different
  // currency later. Nullable at the schema level only so pre-existing
  // stores (created before this field existed) remain readable/writable —
  // the one-time backfill sets them all to 'PKR' (Solvexo was Pakistan-only
  // until this field was introduced).
  @Prop({ type: String, default: null })
  baseCurrency: string | null;

  // "Markets" — which of the platform's `SUPPORTED_CURRENCIES` a buyer may
  // actually check out in on THIS store (real, seller-configurable, distinct
  // from `baseCurrency` which is what the seller is paid/priced in and
  // never changes). Defaults to every supported currency so a pre-existing
  // store's checkout behavior is byte-identical to before this field
  // existed. Deliberately NOT a list of countries/regions/shipping-tax
  // rules — that would need a much larger, disconnected subsystem (per-
  // region shipping/tax) that doesn't exist in this codebase; this is
  // honestly scoped to the one thing the existing FX/checkout-currency
  // pipeline can actually support today: which currencies this store's
  // buyers can pay in.
  @Prop({ type: [String], default: null })
  enabledCurrencies: string[] | null;

  @Prop({ type: String, default: null })
  categoryId!: string | null;

  @Prop({ type: String, default: null })
  description!: string | null;

  // ── Store Settings identity fields (Phase 7) — short marketing line,
  // buyer-facing contact info. Additive, optional, no migration needed.
  @Prop({ type: String, default: null })
  tagline!: string | null;
  @Prop({ type: String, default: null })
  contactEmail!: string | null;
  @Prop({ type: String, default: null })
  contactPhone!: string | null;

  // Was a hardcoded module constant (10) in InventoryService — every store
  // saw the exact same low-stock cutoff regardless of what "low" actually
  // means for their catalog (a seller selling single handmade pieces vs. one
  // selling bulk commodity stock have very different real thresholds).
  @Prop({ type: Number, default: 10, min: 1 })
  lowStockThreshold!: number;

  // Real Staff RBAC (see StaffMember/ApprovalRequest schemas) — a staff
  // member WITHOUT `inventory.approve` who submits a stock adjustment at or
  // above this quantity, or with reason 'damaged'/'write_off' (any
  // quantity), gets a pending ApprovalRequest instead of an immediate
  // mutation. Owner default is a reasonable "don't queue small counts,
  // do queue anything that could materially misstate stock/valuation"
  // threshold — editable per store from the Staff tab.
  @Prop({ type: Number, default: 20, min: 1 })
  staffApprovalThreshold!: number;

  // A deliberately simple flat-rate tax — the DEFAULT rate for any order
  // whose destination doesn't match one of `taxRegions` below (or when the
  // store has no regions configured at all — every pre-existing store's
  // exact prior behavior). 0 = no tax charged. Real per-country/state rates
  // (`taxRegions`) or a live TaxJar quote (see TaxService) both take
  // priority over this when they apply — see CheckoutService.createCheckout's
  // tax-computation comment for the full precedence order.
  @Prop({ type: Number, default: 0, min: 0, max: 100 })
  taxRate!: number;

  // Manual, Shopify-"Tax regions"-style per-destination rates — a seller
  // without a TaxJar account can still charge a DIFFERENT rate per country
  // (and, optionally, per state/province within it) instead of one single
  // flat number for every buyer everywhere. `state: null` matches every
  // state/province within that country. Checked before `taxRate` at
  // checkout, in country+state → country-only → `taxRate` priority order.
  // `country` is the same ISO-3166 alpha-2 code `Address.country` stores
  // (e.g. 'US', 'PK', 'GB') — matched case-insensitively.
  @Prop({
    type: [{ country: { type: String, required: true }, state: { type: String, default: null }, rate: { type: Number, required: true, min: 0, max: 100 } }],
    default: [],
  })
  taxRegions: { country: string; state: string | null; rate: number }[];

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

  // Real, dedicated brand-asset override — a store's `logo` is often a wide
  // rectangular wordmark, which renders poorly shrunk into a 16-32px browser
  // tab icon. Null (the pre-existing-store-safe default) falls back to
  // `logo`, then to the platform default, exactly matching the storefront's
  // behavior before this field existed — see `StorefrontLayout.tsx`'s
  // `useStorefrontFavicon`. Not the same concept as `logo`/`coverImage`
  // (storefront-visible brand imagery) — this is chrome-only, never rendered
  // inside the page itself.
  @Prop({ type: String, default: null })
  faviconUrl: string | null;

  // Platform-plan-gated features (see EntitlementsService) — dedicated fields
  // rather than buried inside the opaque `builderConfig` blob, so backend
  // enforcement doesn't depend on parsing arbitrary frontend-owned JSON.
  @Prop({ type: String, default: null })
  customDomain: string | null;

  // 'unverified' whenever `customDomain` is first set or changed — flips to
  // 'verified' only once `StoreService.verifyCustomDomain` confirms the
  // domain's own DNS actually CNAMEs to our platform target (see
  // `CUSTOM_DOMAIN_CNAME_TARGET`). Public storefront resolution by domain
  // (`getPublicStoreByDomain`) only ever matches a 'verified' domain, so an
  // unverified/unproven claim can never serve as a live storefront.
  @Prop({ type: String, enum: ['unverified', 'verified'], default: 'unverified' })
  customDomainStatus: 'unverified' | 'verified';

  @Prop({ type: Boolean, default: false })
  whiteLabelEnabled: boolean;

  // Real Shopify-style storefront access gate — deliberately independent of
  // `status` above (a marketplace-listing/admin-review concept): a seller
  // can gate their own already-active store's subdomain while building it
  // out, or announce an upcoming relaunch, without touching admin review at
  // all. `'public'` (default) is byte-identical to every store's behavior
  // before this field existed. Enforced by `StorefrontLayout.tsx` gating the
  // storefront's OWN chrome/routes client-side — a disclosed scope boundary
  // (same category as this file's own Custom Domain comment above): the
  // underlying public product/category APIs are not separately locked down,
  // since this is a "hide the storefront from ordinary visitors" gate, not
  // a security boundary for the data itself.
  @Prop({ type: String, enum: ['public', 'password', 'coming_soon'], default: 'public' })
  privacyMode: 'public' | 'password' | 'coming_soon';

  // bcrypt hash only — the plaintext password is never persisted. `select:
  // false` so it never rides along on a public store fetch; only
  // `StoreService.verifyStorePassword` opts in via `.select('+storePasswordHash')`.
  // Kept around even after switching back to 'public' so re-enabling
  // password mode later doesn't force the seller to re-type it.
  @Prop({ type: String, default: null, select: false })
  storePasswordHash: string | null;

  @Prop({ type: Number, default: 0 })
  followersCount: number;

  // Persisted rollup from Rating docs (storeId-scoped) — recalculated by
  // RatingService.recalcStoreRating(), same pattern as Product.averageRating.
  @Prop({ type: Number, default: 0 })
  averageRating: number;

  @Prop({ type: Number, default: 0 })
  reviewCount: number;

  // Marketplace LISTING lifecycle only — deliberately independent of
  // verification (see VerificationStatus below). New stores start 'pending'
  // (a Lead) and an admin must approve them via
  // AdminMarketplaceService.approveLead before they flip to 'active'; today
  // that admin action happens to move both this field and
  // `verificationStatus` together (Solvexo has one review action, not two),
  // but they remain separate fields so that's a business-process fact, not
  // a schema constraint. Every public/browse route already filters
  // `status: 'active'` (see StoreService.getStoreBySlug/discoverStores/
  // etc.), so anything else is automatically excluded from the marketplace
  // with no extra filtering needed. The seller's own dashboard
  // (getMyStores/getStoreById) does NOT filter by status, so the seller can
  // still see and prep their store while it's awaiting review.
  @Prop({ enum: ['pending', 'active', 'rejected', 'suspended'], default: 'pending' })
  status: string;

  // Set by AdminMarketplaceService.rejectLead — shown back to the seller so
  // a rejection isn't a silent dead end.
  @Prop({ type: String, default: null })
  rejectionReason: string | null;

  @Prop({ type: Date, default: null })
  reviewedAt: Date | null;

  // ── Verification classification/state — top-level (not `select: false`):
  // none of these four are sensitive on their own (no tax IDs, no document
  // refs), and `resolveSellerDestinationRemote`, the admin Leads list, and
  // requirement calculation all need them cheaply without opting into the
  // sensitive `verification` blob below. ──

  // Where the seller says they operate — drives requirement calculation
  // (see verification-requirements.config.ts). Defaults to Solvexo's home
  // market; genuinely different per-country legal rules can be added to
  // that config later without touching this field.
  @Prop({ type: String, default: 'PK' })
  country: string;

  @Prop({ type: String, enum: BUSINESS_TYPES, default: null })
  businessType: BusinessType | null;

  // Server-derived from `businessType` via `determineVerificationLevel` —
  // never accepted from the client. Recomputed every time businessType is
  // saved (see StoreService.updateVerification).
  @Prop({ type: String, enum: VERIFICATION_LEVELS, default: null })
  verificationLevel: VerificationLevel | null;

  // The KYC review's own state — independent of `status` above. See
  // `assertValidVerificationTransition` for the allowed transitions.
  @Prop({ type: String, enum: VERIFICATION_STATUSES, default: 'not_started' })
  verificationStatus: VerificationStatus;

  // Business verification (KYC-style) — deliberately `select: false` so it
  // never rides along on any public/storefront/product query by accident;
  // only the seller's own verification endpoints and the admin Leads detail
  // endpoint opt in via `.select('+verification')`. Contains sensitive
  // fields (tax id, ID document refs) that must never reach a public API
  // response.
  @Prop({ type: SellerVerificationSchema, default: () => ({}), select: false })
  verification: SellerVerification;

  // admin-granted badges, e.g. ['top_seller', 'verified', 'featured', 'verified_educator']
  @Prop({ type: [String], default: [] })
  badges: string[];

  @Prop({ default: false })
  isDelete: boolean;

  // Per-seller Cash-on-Delivery opt-out (see PaymentService.codPayment) —
  // sellers uncomfortable with COD's non-payment/return risk can disable it
  // for their own store. No platform-wide order-value ceiling — COD is
  // available for any amount as long as the store allows it.
  @Prop({ type: Boolean, default: true })
  codEnabled: boolean;

  // Shopify's real "Payment capture method" setting — mirrors its two
  // most-used options ("Automatically at checkout" / "Manually") out of its
  // four. 'automatic' (default — every existing store's unchanged behavior)
  // charges the buyer's card the instant checkout succeeds, same as today.
  // 'manual' authorizes the card (holds funds, doesn't take them) and lets
  // the seller review the order before actually charging it via a real
  // Stripe capture call — see PaymentService.initiatePayment (capture_method
  // on the PaymentIntent) and OrdersService.captureOrderPayment. Only takes
  // effect for a single-store checkout — same simplification
  // `getEligibleConnectAccountForStore` already uses, since Stripe's
  // capture_method is set once per PaymentIntent, not per line item.
  @Prop({ type: String, enum: ['automatic', 'manual'], default: 'automatic' })
  paymentCaptureMethod: string;

  // Real Shopify-equivalent "customize your dashboard metrics" — which
  // metric cards the seller's own Store Dashboard shows, and in what order.
  // `null`/empty (every pre-existing store) means "show the default set"
  // (see DASHBOARD_METRIC_CATALOG's `default` flag in
  // store-dashboard-metrics.const.ts, the single source of truth both this
  // backend and the frontend picker read from) — never hand-guessed here.
  @Prop({ type: [String], default: null })
  dashboardMetrics: string[] | null;

  // Opt-in per-store review moderation gate — off by default so every
  // existing store keeps today's behavior (a review publishes the instant
  // it's submitted). A seller who turns this on gets a real approve/reject
  // queue instead (see `RatingService.addReview`/`getStoreReviews`).
  @Prop({ type: Boolean, default: false })
  reviewModerationEnabled: boolean;

  @Prop({ type: StoreSeoSchema, default: () => ({}) })
  seo: StoreSeo;

  // "Manual Pin"/"Seller Featured" collapsed into one mechanism — an ordered
  // list of product ids a seller pins to the top of their storefront. Capped
  // at read-time via PlatformConfig.placementLimits.storeFeaturedProducts.
  @Prop({ type: [String], default: [] })
  pinnedProductIds: string[];

  @Prop({ type: StoreAnnouncementBarSchema, default: () => ({}) })
  announcementBar: StoreAnnouncementBar;

  // Real Shopify-style "Customer Privacy" — a cookie-consent banner that
  // gates tracking-pixel script injection (see `StorefrontLayout.tsx`'s
  // pixel-loading effect) until a visitor accepts, plus a CCPA-style
  // disclosure link. Off by default — every pre-existing store keeps
  // today's behavior (pixels load unconditionally) until a seller opts in,
  // matching this app's convention of never inventing a compliance
  // requirement for a seller that hasn't asked for one (see `taxRate`'s own
  // "not a tax-compliance engine" disclaimer for the same reasoning).
  @Prop({ type: Boolean, default: false })
  cookieBannerEnabled: boolean;

  @Prop({ type: String, default: null })
  cookieBannerMessage: string | null;

  @Prop({ type: Boolean, default: false })
  showDoNotSellLink: boolean;

  // Real Shopify-style region scoping for the cookie banner — 'all' shows it
  // to every visitor (default, matches how it behaved before this field
  // existed); 'eu_uk_only' only shows it to a visitor whose IP resolves to
  // an EU member state or the UK (see `isEuOrUkCountry()` in
  // store.service.ts), same real-region gate Shopify's own cookie-banner
  // "regions with consent laws" option uses.
  @Prop({ type: String, enum: ['all', 'eu_uk_only'], default: 'all' })
  cookieBannerRegionMode: 'all' | 'eu_uk_only';

  // Real Shopify-style cookie-banner appearance controls — purely cosmetic,
  // no effect on consent/enforcement logic. 'bottom_bar' (default) is the
  // full-width bar every pre-existing store already renders; 'bottom_corner'
  // is a compact floating card. 'dark' (default) matches the original
  // fixed look; 'light'/'brand' let a seller match their own storefront.
  @Prop({ type: String, enum: ['bottom_bar', 'bottom_corner'], default: 'bottom_bar' })
  cookieBannerPosition: 'bottom_bar' | 'bottom_corner';

  @Prop({ type: String, enum: ['dark', 'light', 'brand'], default: 'dark' })
  cookieBannerColorMode: 'dark' | 'light' | 'brand';

  // Real Shopify "Data sale opt-out requests" — a visitor submits their
  // email via the storefront's "Do Not Sell My Personal Information" dialog
  // (see AtelierFooter.tsx/NovaFooter.tsx), the seller reviews/marks it
  // resolved from the Privacy settings tab. An embedded array (not a
  // separate collection) since real submission volume is genuinely tiny —
  // most stores will never receive one.
  @Prop({
    type: [{ email: String, status: { type: String, enum: ['pending', 'completed'], default: 'pending' }, createdAt: { type: Date, default: Date.now } }],
    default: [],
  })
  privacyRequests: { _id?: string; email: string; status: 'pending' | 'completed'; createdAt: Date }[];
}

export const StoreSchema = SchemaFactory.createForClass(Store);

StoreSchema.index({ sellerId: 1 });
StoreSchema.index({ slug: 1 });
StoreSchema.index({ name: 1 });
StoreSchema.index({ sellerType: 1 });
StoreSchema.index({ averageRating: -1 });
StoreSchema.index({ followersCount: -1 });