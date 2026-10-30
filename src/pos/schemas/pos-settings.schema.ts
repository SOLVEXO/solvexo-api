/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PosSettingsDocument = PosSettings & Document;

@Schema({ timestamps: true })
export class PosSettings {
  @Prop({ required: true, unique: true })
  storeId: string;

  @Prop({ type: Number, default: 0, min: 0, max: 1 })
  taxRate: number;             // e.g. 0.05 = 5% — applied to subtotal if sale.tax not provided

  @Prop({ type: String, default: null })
  receiptHeader: string | null;

  @Prop({ type: String, default: null })
  receiptFooter: string | null;

  @Prop({ type: String, default: null })
  businessName: string | null;

  @Prop({ type: String, default: null })
  businessAddress: string | null;

  @Prop({ type: String, default: null })
  currencySymbol: string | null;   // legacy free text — the app now derives the symbol from the store's currency code

  // Printed on receipts when set (VAT / GST / NTN number).
  @Prop({ type: String, default: null })
  businessTaxId: string | null;

  @Prop({ type: Number, default: 0 })
  saleCounter: number;         // atomically incremented to mint saleNumber ("POS-00001") per store
}

export const PosSettingsSchema = SchemaFactory.createForClass(PosSettings);

PosSettingsSchema.index({ storeId: 1 }, { unique: true });
