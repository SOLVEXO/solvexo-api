import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ActivityLogDocument = ActivityLog & Document;

export const ACTIVITY_LOG_CATEGORIES = [
  'products',
  'inventory',
  'orders',
  'finance',
  'marketing',
  'customers',
  'settings',
  'security',
  'loyalty',
  'subscriptions',
  'platform_billing',
  'admin_audit',
  'admin_team',
  'platform_plans',
  'seo',
  'integrations',
  'announcements',
  'moderation',
  'promotions',
  // Written by newer modules whose entries were silently dropped before these were listed (the enum rejected them).
  'b2b',
  'khata',
  'fulfillment',
  'checkout_rules',
  'experiments',
  'apps',
  'webhooks',
  'api_tokens',
  'api_token',
] as const;

/** Categories that are never auto-deleted — they are the evidence trail for money, access and admin actions. */
export const ACTIVITY_LOG_KEEP_FOREVER: readonly string[] = ['security', 'finance', 'admin_audit', 'admin_team', 'platform_billing', 'platform_plans', 'moderation'];

export type ActivityLogCategory = (typeof ACTIVITY_LOG_CATEGORIES)[number];

@Schema({ timestamps: true })
export class ActivityLog {
  // 'platform' sentinel = a platform-level action with no single store
  // (e.g. admin creating/editing a PlatformPlan) rather than a real store id.
  @Prop({ type: String, default: 'platform' })
  storeId: string;

  @Prop({ type: String, default: null })
  actorId: string | null;

  @Prop({ type: String, default: null })
  actorName: string | null;

  @Prop({ type: String, default: null })
  actorRole: string | null;

  @Prop({ required: true, enum: ACTIVITY_LOG_CATEGORIES })
  category: ActivityLogCategory;

  @Prop({ required: true })
  action: string;

  @Prop({ type: String, default: null })
  description: string | null;

  @Prop({ type: String, default: null })
  targetId: string | null;

  @Prop({ type: String, default: null })
  targetType: string | null;

  @Prop({ type: String, default: null })
  ip: string | null;

  @Prop({ type: String, default: null })
  userAgent: string | null;

  @Prop({ type: Boolean, default: false })
  isSecurityAlert: boolean;

  @Prop({ type: Object, default: null })
  metadata: object | null;

  /** TTL: Mongo deletes the row after this date. Left unset for security / finance / admin entries, which are kept for good. */
  @Prop({ type: Date })
  expireAt?: Date;
}

export const ActivityLogSchema = SchemaFactory.createForClass(ActivityLog);

// Rows without expireAt never expire (every row written before this field existed is therefore untouched).
ActivityLogSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
ActivityLogSchema.index({ storeId: 1, createdAt: -1 });
ActivityLogSchema.index({ storeId: 1, category: 1 });
ActivityLogSchema.index({ storeId: 1, actorId: 1 });
ActivityLogSchema.index({ storeId: 1, isSecurityAlert: 1 });
