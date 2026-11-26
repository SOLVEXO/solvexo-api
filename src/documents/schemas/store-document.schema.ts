import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/** What a store document is used for — the seller picks one, the storefront groups by it. */
export const STORE_DOCUMENT_CATEGORIES = ['catalogue', 'brochure', 'price_list', 'manual', 'certificate', 'other'] as const;
export type StoreDocumentCategory = (typeof STORE_DOCUMENT_CATEGORIES)[number];

/** A file the seller uploaded once and can link/show anywhere (menu, button, section, product). */
@Schema({ timestamps: true, collection: 'storedocuments' })
export class DocumentFile {
  _id: string;

  @Prop({ type: String, required: true, index: true })
  storeId: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  title: string;

  @Prop({ type: String, enum: STORE_DOCUMENT_CATEGORIES, default: 'catalogue' })
  category: StoreDocumentCategory;

  @Prop({ type: String, default: '', maxlength: 500 })
  description: string;

  /** Cloudinary URL of the file itself (a `raw` PDF, or an image). */
  @Prop({ type: String, required: true })
  fileUrl: string;

  /** Cloudinary public id — the file is replaced in place, so no link ever breaks. */
  @Prop({ type: String, required: true })
  publicId: string;

  @Prop({ type: String, enum: ['raw', 'image'], default: 'raw' })
  resourceType: string;

  /** Cover photo: the PDF's own first page when Cloudinary can render it, else a seller upload. */
  @Prop({ type: String, default: null })
  coverUrl: string | null;

  @Prop({ type: String, default: null })
  coverPublicId: string | null;

  @Prop({ type: Number, default: null })
  sizeBytes: number | null;

  @Prop({ type: Number, default: null })
  pages: number | null;

  /** BCP-47-ish tag the seller typed (en, ur, …). Empty = not set. */
  @Prop({ type: String, default: '', maxlength: 12 })
  language: string;

  @Prop({ type: String, enum: ['active', 'hidden'], default: 'active' })
  status: string;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;

  @Prop({ type: Number, default: 0 })
  viewCount: number;

  @Prop({ type: Number, default: 0 })
  downloadCount: number;

  @Prop({ type: Date, default: null })
  lastViewedAt: Date | null;

  @Prop({ type: String, default: null })
  createdBy: string | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export type DocumentFileDocument = HydratedDocument<DocumentFile>;
export const DocumentFileSchema = SchemaFactory.createForClass(DocumentFile);

DocumentFileSchema.index({ storeId: 1, isDelete: 1, status: 1, category: 1 });
DocumentFileSchema.index({ storeId: 1, isDelete: 1, title: 1 });