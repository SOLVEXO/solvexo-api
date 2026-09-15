/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StaffMemberDocument = StaffMember & Document;

/** Every permission a staff member can be granted — deliberately scoped to
 *  the real gaps this pass targets (Inventory/Purchase Orders/Stock Counts)
 *  rather than a full re-implementation of every seller-dashboard route's
 *  access control (that would be its own, much larger project — see this
 *  pass's own "Deferred" scope notes). `staff.manage` lets a manager invite/
 *  edit/deactivate other staff and set the approval threshold — deliberately
 *  NEVER grantable by a staff member to themselves (enforced in
 *  StaffService, not just hidden in the UI). */
export const STAFF_PERMISSIONS = [
  'inventory.view',
  'inventory.adjust',
  'inventory.receive',
  'inventory.transfer',
  'inventory.count',
  'inventory.approve', // can approve another staff member's pending large/damage adjustment
  'purchase_orders.manage',
  'staff.manage',
] as const;
export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

export const STAFF_ROLES = ['manager', 'staff'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** A real, store-scoped staff login — distinct from both the seller's own
 *  JWT (unlimited access to everything they own) and the POS PIN-login
 *  Employee (register-only, no dashboard access at all). A StaffMember logs
 *  into the actual seller dashboard with a real email+password, but scoped
 *  to exactly one store and gated by `permissions` on every sensitive
 *  Inventory/Purchase-Order/Stock-Count route (see PermissionsGuard). The
 *  owning seller (`sellerId`) always has full, ungated access regardless of
 *  what's configured here — this schema only ever restricts a STAFF
 *  identity, never the owner's own. */
@Schema({ timestamps: true })
export class StaffMember {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string; // owner who created this staff account

  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, required: true }) email: string;
  @Prop({ type: String, required: true, select: false }) passwordHash: string;

  @Prop({ type: String, enum: STAFF_ROLES, default: 'staff' }) role: StaffRole;
  @Prop({ type: [String], enum: STAFF_PERMISSIONS, default: [] }) permissions: StaffPermission[];

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
