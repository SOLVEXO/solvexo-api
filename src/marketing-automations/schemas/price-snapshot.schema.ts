/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PriceSnapshotDocument = HydratedDocument<PriceSnapshot>;

/** Last price the price-drop cron saw for a wishlisted variant. A drop is
 *  measured against this (not the all-time high), so each real markdown
 *  triggers one alert and a price that bounces back up resets the baseline. */
@Schema({ timestamps: true })
export class PriceSnapshot {
  _id: string;

  @Prop({ required: true, unique: true }) variantId: string;
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) price: number;
}

export const PriceSnapshotSchema = SchemaFactory.createForClass(PriceSnapshot);
