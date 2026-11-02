/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PosSettingsDocument = PosSettings & Document;

@Schema({ timestamps: true })
export class PosSettings {
  @Prop({ required: true, unique: true })
  storeId: string;

  @Prop({ type: Number, default: 0, min: 0, max: 1 })
  taxRate: number;

  // Idle minutes before the till locks to the PIN screen (owner-set; the cart and the offline queue are kept).
  @Prop({ type: Number, default: 5, min: 1, max: 240 })
  autoLockMinutes: number;             // e.g. 0.05 = 5% — applied to subtotal if sale.tax not provided

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

  // Bumped (and the previous values kept in PosSettingsVersion) whenever something that changes how a sale is priced
  // changes — currently the tax rate. Sale requests carry the version they were priced with. See PosService.pricingFor.
  @Prop({ type: Number, default: 1 })
  settingsVersion: number;

  @Prop({ type: Number, default: 0 })
  saleCounter: number;         // atomically incremented to mint saleNumber ("POS-00001") per store
}

export const PosSettingsSchema = SchemaFactory.createForClass(PosSettings);

PosSettingsSchema.index({ storeId: 1 }, { unique: true });
