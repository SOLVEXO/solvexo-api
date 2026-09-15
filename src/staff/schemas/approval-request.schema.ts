/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ApprovalRequestDocument = ApprovalRequest & Document;

export const APPROVAL_REQUEST_TYPES = ['stock_adjustment'] as const;
export type ApprovalRequestType = (typeof APPROVAL_REQUEST_TYPES)[number];
export const APPROVAL_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

/** Real approval-queue row — the actual enforcement mechanism behind
 *  `inventory.approve`. A staff member (see StaffMember) who lacks
 *  `inventory.approve` and attempts an adjustment at/above the store's
 *  `staffApprovalThreshold` (see Store schema) OR a 'damaged'/'write_off'
 *  reason never mutates real stock directly — `InventoryService.adjustStock`
 *  instead creates one of these, pending, and returns it without touching
 *  `ProductVariant`. Only a seller/admin, or a staff member WITH
 *  `inventory.approve`, can later call `approve()` — which is the ONLY code
 *  path that re-invokes the real `adjustStock` logic with the original
 *  snapshotted args. Rejecting one simply marks it rejected — nothing to
 *  undo, since nothing was ever applied. */
@Schema({ timestamps: true })
export class ApprovalRequest {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, enum: APPROVAL_REQUEST_TYPES, required: true }) type: ApprovalRequestType;

  // Snapshot of the original mutating call's arguments — re-applied verbatim
  // on approve(), never re-derived from current state (which may have
  // changed since the request was raised).
  @Prop({ type: Object, required: true }) payload: Record<string, any>;

  // Denormalized for a readable queue without a join — what this request is
  // actually asking to change, shown as-is in the approvals list UI.
  @Prop({ type: String, required: true }) summary: string;

  @Prop({ type: String, required: true }) requestedBy: string;
  @Prop({ type: String, default: null }) requestedByName: string | null;

  @Prop({ type: String, enum: APPROVAL_REQUEST_STATUSES, default: 'pending' }) status: ApprovalRequestStatus;
  @Prop({ type: String, default: null }) reviewedBy: string | null;
  @Prop({ type: String, default: null }) reviewedByName: string | null;
  @Prop({ type: Date, default: null }) reviewedAt: Date | null;
  @Prop({ type: String, default: null }) rejectionReason: string | null;
}

export const ApprovalRequestSchema = SchemaFactory.createForClass(ApprovalRequest);
ApprovalRequestSchema.index({ storeId: 1, status: 1, createdAt: -1 });
