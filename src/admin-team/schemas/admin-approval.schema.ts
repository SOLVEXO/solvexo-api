import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AdminApprovalDocument = AdminApproval & Document;

/** A sensitive action a team admin asked to perform. A Super Admin approves it, which opens a one-time,
 *  short-lived grant: the admin repeats the action and the grant is consumed (see PermissionsGuard). */
@Schema({ timestamps: true })
export class AdminApproval {
  @Prop({ type: String, required: true }) action: string; // e.g. 'payout.manual' (see ADMIN_APPROVAL_ACTIONS)
  @Prop({ type: String, required: true }) summary: string; // human text: "POST /api/admin/finance/..."
  @Prop({ type: String, required: true }) requestedBy: string;
  @Prop({ type: String, default: null }) requestedByName: string | null;
  @Prop({ type: String, enum: ['pending', 'approved', 'rejected', 'used', 'expired'], default: 'pending' }) status: string;
  @Prop({ type: String, default: null }) decidedBy: string | null;
  @Prop({ type: String, default: null }) decidedByName: string | null;
  @Prop({ type: Date, default: null }) decidedAt: Date | null;
  @Prop({ type: String, default: null }) note: string | null;
  // pending: when the request itself goes stale; approved: how long the one-time grant stays usable.
  @Prop({ type: Date, required: true }) expiresAt: Date;
}

export const AdminApprovalSchema = SchemaFactory.createForClass(AdminApproval);
AdminApprovalSchema.index({ requestedBy: 1, action: 1, status: 1 });
AdminApprovalSchema.index({ status: 1, createdAt: -1 });
