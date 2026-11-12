/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import '../../common/schema-types/minor-money';

@Schema({ _id: true })
export class PosModifierOption {
  @Prop({ type: String, required: true }) name: string;
  /** added to the line's unit price (minor units of the store currency; 0 = free choice) */
  @Prop({ type: 'MinorMoney', required: true }) priceDeltaMinor: number;
  @Prop({ type: Boolean, default: true }) active: boolean;
}
export const PosModifierOptionSchema = SchemaFactory.createForClass(PosModifierOption);

export type PosModifierGroupDocument = PosModifierGroup & Document;
/** G4.5: a modifier group ("Size", "Milk", "Extras") with its options and how many may be chosen, attached to products. Edited by managers (audited). */
@Schema({ timestamps: true })
export class PosModifierGroup {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: Number, default: 0, min: 0 }) minSelect: number;
  @Prop({ type: Number, default: 1, min: 1 }) maxSelect: number;
  @Prop({ type: [PosModifierOptionSchema], default: [] }) options: (PosModifierOption & { _id: Types.ObjectId })[];
  @Prop({ type: [String], default: [] }) productIds: string[];
  @Prop({ type: Number, default: 0 }) sortOrder: number;
  @Prop({ type: Boolean, default: true }) active: boolean;
}
export const PosModifierGroupSchema = SchemaFactory.createForClass(PosModifierGroup);
PosModifierGroupSchema.set('toJSON', { getters: true, virtuals: false });
PosModifierGroupSchema.set('toObject', { getters: true, virtuals: false });
PosModifierGroupSchema.index({ storeId: 1, productIds: 1 });

@Schema({ _id: false })
export class PosPriceBookEntry {
  @Prop({ type: String, required: true }) variantId: string;
  @Prop({ type: 'MinorMoney', required: true }) priceMinor: number;
}
export const PosPriceBookEntrySchema = SchemaFactory.createForClass(PosPriceBookEntry);

export type PosPriceBookDocument = PosPriceBook & Document;
/**
 * G4.5: a price book — another price for some variants ("Wholesale", "Staff", "Ramadan"). Applies when the cashier picks it at checkout or when the sale's customer
 * is assigned to it; variants it does not list keep their list price. Optional active window. Edited by managers (audited).
 */
@Schema({ timestamps: true })
export class PosPriceBook {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: Boolean, default: true }) active: boolean;
  @Prop({ type: Date, default: null }) startsAt: Date | null;
  @Prop({ type: Date, default: null }) endsAt: Date | null;
  @Prop({ type: [PosPriceBookEntrySchema], default: [] }) entries: PosPriceBookEntry[];
  @Prop({ type: String, default: null }) note: string | null;
}
export const PosPriceBookSchema = SchemaFactory.createForClass(PosPriceBook);
PosPriceBookSchema.set('toJSON', { getters: true, virtuals: false });
PosPriceBookSchema.set('toObject', { getters: true, virtuals: false });
PosPriceBookSchema.index({ storeId: 1, name: 1 });
