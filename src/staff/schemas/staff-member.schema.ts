/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StaffMemberDocument = StaffMember & Document;

/** Every permission a staff member can be granted — a real, store-wide
 *  taxonomy benchmarked against Shopify's actual live "Store permissions"
 *  list (help.shopify.com, 19 categories / 110 individual permissions,
 *  fetched and verified this session, not assumed). Every key below maps
 *  to a Shopify permission that a code-level audit confirmed ALREADY has a
 *  real, independently-gatable Solvexo capability behind it ("Tier 1" of
 *  that audit's 45/23/42 Yes/Partial/No breakdown) — see the project plan
 *  for the full matrix. Deliberately NOT yet included (a Shopify
 *  permission exists but Solvexo's underlying capability is either fused
 *  with something else and can't be independently granted yet, or doesn't
 *  exist at all): per-field product price/cost editing, order line-item
 *  editing, draft-order card charging, customer GDPR tools, B2B Companies,
 *  Store Credit, App Development, Checkout Settings — see the plan's
 *  "Tier 2"/"Tier 3" for exactly what each would need.
 *
 *  Two DISCLOSED merges where Solvexo's actual route granularity doesn't
 *  support Shopify's finer split (flagged, not silently forced):
 *  `onlinestore.content.manage` covers BOTH "Blog posts and pages" AND
 *  "Manage store policies" (Shopify's two separate Settings-category
 *  permissions) — both are the same `store-pages` controller in Solvexo,
 *  with no server-side way to tell a policy page apart from a content page
 *  at the route level. `products.view` grants the SAME view Shopify's
 *  "View" (cost excluded) and "View cost" permissions together grant, since
 *  Solvexo has no cost-field-exclusion mechanism — granting it is granting
 *  cost visibility too, disclosed here and in the plan.
 *
 *  `staff.manage` lets a manager invite/edit/deactivate other staff and
 *  manage Roles — deliberately NEVER grantable by a staff member to
 *  themselves (enforced in StaffService, not just hidden in the UI).
 *
 *  `settings.payments.manage` (Store Settings: "Manage payments settings" —
 *  which checkout payment PROVIDERS are configured/enabled, gates
 *  `SellerIntegrationsController`) was split out from `finance.payments.manage`
 *  (Finance: "Manage other payment settings" — the seller's own Stripe
 *  Connect payout account, gates `StripeConnectController`) after a review
 *  confirmed these were two genuinely distinct Shopify permissions that had
 *  been merged onto one key. Both controllers surface on the same
 *  Integrations page, so a staff member needs BOTH to fully manage Stripe
 *  there (`settings.payments.manage` to see/configure it as a checkout
 *  provider, `finance.payments.manage` to actually connect/sync the payout
 *  account) — intentional, mirrors Shopify's own split where connecting a
 *  payment provider that also moves money touches both categories. */
export const STAFF_PERMISSIONS = [
  // Home
  'home.view',
  // Orders
  'orders.view', 'orders.export', 'orders.fulfill', 'orders.capture_payment',
  'orders.buy_shipping_label', 'orders.return', 'orders.abandoned_checkouts', 'orders.cancel',
  'orders.refund', 'orders.record_payment', 'orders.disputes_manage',
  // Draft Orders
  'draft_orders.view', 'draft_orders.mark_paid',
  // Products
  'products.view', 'products.view_cost', 'products.export', 'products.delete', 'products.edit', 'products.edit_price', 'products.edit_cost',
  // Inventory / Purchase Orders / Stock Counts (unchanged from the earlier Inventory-only pass)
  'inventory.view', 'inventory.adjust', 'inventory.receive', 'inventory.transfer',
  'inventory.count', 'inventory.approve', 'purchase_orders.manage',
  // Gift Cards
  'giftcards.view', 'giftcards.deactivate', 'giftcards.manage',
  // Customers
  'customers.view', 'customers.export', 'customers.edit',
  // Analytics
  'analytics.view',
  // Marketing (platform-campaign opt-in) / Discounts (own coupons + automatic discounts —
  // separate keys since Shopify treats these as two distinct permission categories)
  'marketing.manage', 'discounts.manage',
  // Content (Menus + Metaobjects) / Files
  'content.menus.manage', 'content.metaobjects.manage', 'files.manage',
  // Online Store (Themes, Blog/Pages, Store Policies — see disclosed merge above)
  'onlinestore.themes.manage', 'onlinestore.content.manage',
  // Store Settings
  'settings.billing.view', 'settings.billing.manage', 'settings.general.manage', 'settings.taxes.manage',
  'settings.shipping.manage', 'settings.locations.manage',
  'settings.domains.manage', 'settings.pixels.manage', 'settings.payments.manage',
  // Finance
  'finance.payouts.view', 'finance.payments.manage', 'finance.tax_documents.manage',
  // Staff management itself
  'staff.manage',
] as const;
export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

export const STAFF_ROLES = ['manager', 'staff'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** A real, store-scoped staff login — distinct from both the seller's own
 *  JWT (unlimited access to everything they own) and the POS PIN-login
 *  Employee (register-only, no dashboard access at all). A StaffMember logs
 *  into the actual seller dashboard with a real email+password, but scoped
 *  to exactly one store and gated by their assigned `Role`'s permissions
 *  on every sensitive route (see PermissionsGuard). The owning seller
 *  (`sellerId`) always has full, ungated access regardless of what's
 *  configured here — this schema only ever restricts a STAFF identity,
 *  never the owner's own. */
@Schema({ timestamps: true })
export class StaffMember {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string; // owner who created this staff account

  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, required: true }) email: string;
  @Prop({ type: String, required: true, select: false }) passwordHash: string;

  // A plain display label (Shopify-parity Role/permissions live on the
  // separate `Role` entity below — this is just "what to call this person
  // in the staff list," not an access-control field).
  @Prop({ type: String, enum: STAFF_ROLES, default: 'staff' }) role: StaffRole;

  // The real Shopify-parity access-control assignment — a StaffMember has
  // exactly one Role at a time (matches Shopify's own real model: a staff
  // member is assigned ONE role, never an ad-hoc per-staff permission
  // list). Nullable only until a Role is actually assigned (e.g. mid-
  // creation flow) — `StaffService` resolves `Role.permissions` at login
  // time and embeds them in the JWT, same as before.
  @Prop({ type: String, default: null }) roleId: string | null;

  // Restricts which physical branch this staff member can act on — null
  // means unrestricted (can act on any of the store's locations), same
  // convention as Employee.locationId (POS).
  @Prop({ type: String, default: null }) locationId: string | null;

  // Bumped on password change/permission change/deactivation — same
  // immediate-revocation mechanism JwtAuthGuard already uses for
  // User/Seller/Admin tokenVersion.
  @Prop({ type: Number, default: 0 }) tokenVersion: number;

  @Prop({ type: String, enum: ['active', 'inactive'], default: 'active' }) status: string;
  @Prop({ default: false }) isDelete: boolean;
}

export const StaffMemberSchema = SchemaFactory.createForClass(StaffMember);
StaffMemberSchema.index({ storeId: 1, status: 1 });
StaffMemberSchema.index({ storeId: 1, email: 1 }, { unique: true });
