/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type EmployeeDocument = Employee & Document;

export enum EmployeeRole {
  CASHIER = 'cashier',
  MANAGER = 'manager',
}

@Schema({ timestamps: true })
export class Employee {
  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true })
  sellerId: string;             // maalik (quick filter)

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  email: string;

  @Prop({ select: false })
  pin: string;                  // 4-digit POS login PIN (hashed)

  @Prop({ enum: Object.values(EmployeeRole), default: EmployeeRole.CASHIER })
  role: string;

  @Prop({ type: [String], default: [] })
  shiftIds: string[];           // store.shifts ke _id (kis shift pe assign)

  @Prop({ enum: ['active', 'inactive'], default: 'active' })
  status: string;

  @Prop({ default: false })
  isDelete: boolean;
}

export const EmployeeSchema = SchemaFactory.createForClass(Employee);

EmployeeSchema.index({ storeId: 1 });
EmployeeSchema.index({ sellerId: 1 });
EmployeeSchema.index({ email: 1 });