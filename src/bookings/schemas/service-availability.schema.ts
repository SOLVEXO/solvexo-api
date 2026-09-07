/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ServiceAvailabilityDocument = ServiceAvailability & Document;

export interface WeeklyRule {
  dayOfWeek: number; // 0=Sunday .. 6=Saturday
  startTime: string; // "HH:mm"
  endTime: string;   // "HH:mm"
}

export interface AvailabilityException {
  date: Date;
  type: 'closed' | 'custom';
  customStart?: string | null;
  customEnd?: string | null;
}

/**
 * One doc per BookableService — the seller's recurring weekly hours plus
 * one-off exceptions (holidays, custom hours). Pure schedule data; slot math
 * lives entirely in `utils/slot-calculator.util.ts` (kept DB-free/pure so
 * it's independently unit-testable).
 */
@Schema({ timestamps: true })
export class ServiceAvailability {
  @Prop({ type: String, required: true }) serviceId: string;
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, required: true }) storeId: string;

  @Prop({ type: [Object], default: [] }) weeklyRules: WeeklyRule[];
  @Prop({ type: [Object], default: [] }) exceptions: AvailabilityException[];
}

export const ServiceAvailabilitySchema = SchemaFactory.createForClass(ServiceAvailability);
ServiceAvailabilitySchema.index({ serviceId: 1 }, { unique: true });
