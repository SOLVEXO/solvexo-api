/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RoleDocument = Role & Document;

/** Real Shopify-parity Role entity — a named, reusable bundle of
 *  permissions, assignable to multiple `StaffMember`s (matches Shopify's
 *  own real model: "A role represents a staff member's job and contains
 *  all the granular permissions that a user requires to do that job...
 *  Roles make it easier to assign the same permission set to multiple
 *  staff", verified live against help.shopify.com this session).
 *  Supersedes the earlier `StaffMember.permissions` flat-array-per-staff
 *  design — `StaffMember.roleId` now points at one of these instead. */
@Schema({ timestamps: true })
export class Role {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, default: null }) description: string | null;
  @Prop({ type: [String], default: [] }) permissions: string[];

  // A handful of seeded, non-deletable starter roles per store (created
  // lazily on first use — see RoleService.ensurePresets) — mirrors
  // Shopify's own out-of-the-box role concept. A seller can still edit a
  // preset's own permission list; `isPreset` only blocks deletion.
  @Prop({ default: false }) isPreset: boolean;

  @Prop({ default: false }) isDelete: boolean;
}

export const RoleSchema = SchemaFactory.createForClass(Role);
RoleSchema.index({ storeId: 1, isDelete: 1 });
