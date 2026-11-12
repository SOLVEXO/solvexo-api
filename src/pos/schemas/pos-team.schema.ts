/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { makeAppendOnly } from './pos-immutable.util';

export const ATTENDANCE_EVENT_TYPES = ['clock_in', 'clock_out', 'break_start', 'break_end', 'correction', 'ack'] as const;

export type PosAttendanceEventDocument = PosAttendanceEvent & Document;
/**
 * G3.6: one APPEND-ONLY attendance event. `deviceAt` is what the till's clock said, `serverAt` when the server wrote it, `at` the EFFECTIVE time used for hours
 * (the device's, unless its clock was ahead of the server). A manager's fix is a `correction` row pointing at the record (never an edit); an `ack` row marks an anomaly reviewed.
 */
@Schema({ timestamps: false })
export class PosAttendanceEvent {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) employeeId: string;
  @Prop({ type: String, enum: ATTENDANCE_EVENT_TYPES, required: true }) type: string;
  /** groups clock_in … clock_out (the clock_in's own id is the record id) */
  @Prop({ type: String, default: null }) recordId: string | null;
  @Prop({ type: Date, required: true }) deviceAt: Date;
  @Prop({ type: Date, required: true }) serverAt: Date;
  @Prop({ type: Date, required: true }) at: Date;
  @Prop({ type: [String], default: [] }) flags: string[];
  @Prop({ type: Object, default: null }) correction: { clockInAt?: Date | null; clockOutAt?: Date | null; voided?: boolean } | null;
  /** ack: the anomaly kind / event it reviewed */
  @Prop({ type: String, default: null }) targetEventId: string | null;
  @Prop({ type: String, default: null }) reason: string | null;
  /** who did it: the person themself, or the manager who corrected / acknowledged */
  @Prop({ type: String, default: null }) actorId: string | null;
  @Prop({ type: String, default: null }) deviceId: string | null;
  @Prop({ type: String, default: null }) registerId: string | null;
  @Prop({ type: String, default: null }) locationId: string | null;
  @Prop({ type: String, default: null }) requestId: string | null;
  /** G5.4 (optional): clocked ON BEHALF of `employeeId` by `actorId` — approved by the member's own PIN or a manager's PIN */
  @Prop({ type: Boolean }) onBehalf?: boolean;
  @Prop({ type: String }) approvedBy?: string;
  @Prop({ type: String, enum: ['member_pin', 'manager_pin'] }) approval?: 'member_pin' | 'manager_pin';
}
export const PosAttendanceEventSchema = SchemaFactory.createForClass(PosAttendanceEvent);
PosAttendanceEventSchema.index({ storeId: 1, employeeId: 1, at: 1 });
PosAttendanceEventSchema.index({ storeId: 1, at: -1 });
PosAttendanceEventSchema.index({ storeId: 1, requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } });
makeAppendOnly(PosAttendanceEventSchema);

export type PosAttendanceStateDocument = PosAttendanceState & Document;
/** The ONE place that says who is clocked in right now (a conditional update on it is what makes "one open record per person" race-proof). A cache of the log: the log is the truth. */
@Schema({ timestamps: true })
export class PosAttendanceState {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) employeeId: string;
  @Prop({ type: String, default: null }) openRecordId: string | null;
  @Prop({ type: Boolean, default: false }) onBreak: boolean;
  @Prop({ type: Date, default: null }) openSince: Date | null;
}
export const PosAttendanceStateSchema = SchemaFactory.createForClass(PosAttendanceState);
PosAttendanceStateSchema.index({ storeId: 1, employeeId: 1 }, { unique: true });

export type PosRosterShiftDocument = PosRosterShift & Document;
/** A planned shift for one person (mutable plan, every change audited; the real hours come from attendance). */
@Schema({ timestamps: true })
export class PosRosterShift {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) employeeId: string;
  @Prop({ type: String, default: null }) locationId: string | null;
  @Prop({ type: Date, required: true }) startAt: Date;
  @Prop({ type: Date, required: true }) endAt: Date;
  @Prop({ type: String, default: null }) note: string | null;
  @Prop({ type: String, enum: ['active', 'cancelled'], default: 'active' }) status: string;
  @Prop({ type: String, default: null }) createdBy: string | null;
}
export const PosRosterShiftSchema = SchemaFactory.createForClass(PosRosterShift);
PosRosterShiftSchema.index({ storeId: 1, startAt: 1 });
PosRosterShiftSchema.index({ storeId: 1, employeeId: 1, startAt: 1 });
