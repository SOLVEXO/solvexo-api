import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ContactSubmissionDocument = HydratedDocument<ContactSubmission>;

export type ContactSubmissionStatus = 'new' | 'read' | 'resolved';

export const CONTACT_SOURCES = ['public', 'seller'] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];
export const SUPPORT_TIERS = ['standard', 'priority', 'dedicated'] as const;
export type SupportTier = (typeof SUPPORT_TIERS)[number];
export const SUPPORT_CATEGORIES = ['orders', 'payments', 'store', 'billing', 'technical', 'other'] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

@Schema({ timestamps: true })
export class ContactSubmission {
  _id: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, trim: true, lowercase: true })
  email: string;

  @Prop({ required: true, trim: true })
  topic: string;

  @Prop({ required: true, trim: true })
  message: string;

  @Prop({ enum: ['new', 'read', 'resolved'], default: 'new' })
  status: ContactSubmissionStatus;

  /** 'public' = the Contact Us form (default, old rows); 'seller' = a help request from a store dashboard. */
  @Prop({ enum: CONTACT_SOURCES, default: 'public' })
  source: ContactSource;

  /** Seller requests only. `tier` is stamped on the server from the store's plan, never from the request body. */
  @Prop({ enum: SUPPORT_TIERS, default: 'standard' })
  tier: SupportTier;

  @Prop({ type: String, default: null })
  storeId?: string | null;

  /** The owning seller of the store (the one who gets in-app notices about replies). */
  @Prop({ type: String, default: null })
  sellerId?: string | null;

  /** Whoever sent it from the dashboard (the owner or a staff member). */
  @Prop({ type: String, default: null })
  requesterId?: string | null;

  @Prop({ type: String, enum: [...SUPPORT_CATEGORIES, null], default: null })
  category?: SupportCategory | null;

  /** Admin answers (also emailed to the requester). */
  @Prop({
    type: [{ _id: false, message: String, sentAt: Date, sentBy: String }],
    default: [],
  })
  replies: { message: string; sentAt: Date; sentBy: string }[];

  createdAt?: Date;
  updatedAt?: Date;
}

export const ContactSubmissionSchema =
  SchemaFactory.createForClass(ContactSubmission);

ContactSubmissionSchema.index({ status: 1 });
ContactSubmissionSchema.index({ createdAt: -1 });
ContactSubmissionSchema.index({ storeId: 1, createdAt: -1 });

ContactSubmissionSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};
