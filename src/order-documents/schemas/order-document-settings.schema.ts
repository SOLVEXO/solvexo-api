/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type OrderDocumentSettingsDocument = OrderDocumentSettings & Document;

export const DOC_PAPER_SIZES = ['a4', 'a5', 'letter', 'thermal80'] as const;
export const DOC_SIZES = ['small', 'medium', 'large'] as const;
export const DOC_ALIGNS = ['left', 'center', 'right'] as const;
export const WATERMARK_TYPES = ['logo', 'text'] as const;
export const WATERMARK_POSITIONS = ['center', 'tiled'] as const;
export const WATERMARK_ANGLES = [0, -30, -45] as const;

/** Print documents (packing slip + invoice) of one store. One doc per store; no doc = the built-in look. */
@Schema({ timestamps: true })
export class OrderDocumentSettings {
  @Prop({ required: true, unique: true })
  storeId: string;

  // ── Business details printed in the header (null = the store's own name / contact email) ──
  @Prop({ type: String, default: null }) companyName: string | null;
  @Prop({ type: String, default: null }) addressText: string | null;
  @Prop({ type: String, default: null }) phone: string | null;
  @Prop({ type: String, default: null }) email: string | null;
  @Prop({ type: String, default: null }) taxIdLabel: string | null;
  @Prop({ type: String, default: null }) taxIdValue: string | null;

  // ── Look ──
  @Prop({ type: String, enum: DOC_PAPER_SIZES, default: 'a4' }) paperSize: string;
  @Prop({ type: String, default: null }) accentColor: string | null;
  @Prop({ type: Boolean, default: true }) showLogo: boolean;
  @Prop({ type: String, enum: DOC_SIZES, default: 'medium' }) logoSize: string;
  @Prop({ type: String, enum: DOC_ALIGNS, default: 'left' }) logoAlign: string;

  // ── Watermark (off unless the seller turns it on) ──
  @Prop({ type: Boolean, default: false }) watermarkEnabled: boolean;
  @Prop({ type: String, enum: WATERMARK_TYPES, default: 'logo' }) watermarkType: string;
  @Prop({ type: String, default: null }) watermarkText: string | null;
  @Prop({ type: String, enum: WATERMARK_POSITIONS, default: 'center' }) watermarkPosition: string;
  @Prop({ type: Number, enum: WATERMARK_ANGLES, default: -30 }) watermarkAngle: number;
  /** Percent, 3-25: how visible it is behind the text. */
  @Prop({ type: Number, default: 8 }) watermarkOpacity: number;
  @Prop({ type: String, enum: DOC_SIZES, default: 'medium' }) watermarkSize: string;

  // ── Packing slip ──
  @Prop({ type: Boolean, default: false }) slipShowPrices: boolean;
  @Prop({ type: Boolean, default: true }) slipShowSku: boolean;
  @Prop({ type: Boolean, default: true }) slipShowImages: boolean;
  @Prop({ type: Boolean, default: true }) slipShowNote: boolean;
  @Prop({ type: Boolean, default: true }) slipShowPayment: boolean;
  @Prop({ type: Boolean, default: true }) slipShowCheckbox: boolean;
  @Prop({ type: String, default: null }) slipMessage: string | null;
  @Prop({ type: String, default: null }) slipFooter: string | null;

  // ── Invoice ──
  @Prop({ type: String, default: null }) invoiceTitle: string | null;
  @Prop({ type: Boolean, default: true }) invoiceShowSku: boolean;
  @Prop({ type: Boolean, default: false }) invoiceShowImages: boolean;
  @Prop({ type: Boolean, default: true }) invoiceShowTaxId: boolean;
  @Prop({ type: String, default: null }) invoiceTerms: string | null;
  @Prop({ type: String, default: null }) invoiceFooter: string | null;

  @Prop({ type: Boolean, default: false }) isDelete: boolean;
}

export const OrderDocumentSettingsSchema = SchemaFactory.createForClass(OrderDocumentSettings);
