/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ServicePackageDocument = ServicePackage & Document;

/** A multi-session bundle a seller can sell against one BookableService (e.g. "5-visit pack"). */
@Schema({ timestamps: true })
export class ServicePackage {
  @Prop({ type: String, required: true }) serviceId: string;
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, required: true }) storeId: string;

  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: Number, required: true }) sessionsCount: number;
  @Prop({ type: Number, required: true }) price: number;
  @Prop({ type: String, default: 'USD' }) currency: string;
  @Prop({ type: Number, required: true }) validityDays: number;

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active' }) status: string;
}

export const ServicePackageSchema = SchemaFactory.createForClass(ServicePackage);
ServicePackageSchema.index({ serviceId: 1, status: 1 });
ServicePackageSchema.index({ storeId: 1 });
