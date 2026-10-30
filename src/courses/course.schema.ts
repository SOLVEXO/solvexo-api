import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CourseDocument = Course & Document;
export type EnrollmentDocument = CourseEnrollment & Document;

/** Modules and lessons are embedded (validated by course.util.sanitizeCourse); lesson/module ids are stable 12-hex strings. */
@Schema({ timestamps: true, collection: 'courses' })
export class Course {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true, maxlength: 120 }) title: string;
  @Prop({ type: String, default: '' }) description: string;
  @Prop({ type: String, enum: ['draft', 'published'], default: 'draft' }) status: string;
  @Prop({ type: String, default: null }) productId: string | null; // the digital product that sells this course
  @Prop({ type: String, default: null }) requiresPlan: string | null; // members of this plan (or higher) get in too
  @Prop({ type: [Object], default: [] }) modules: any[];
}
export const CourseSchema = SchemaFactory.createForClass(Course);
CourseSchema.index({ storeId: 1, status: 1 });
CourseSchema.index({ storeId: 1, productId: 1 });

@Schema({ timestamps: true, collection: 'courseenrollments' })
export class CourseEnrollment {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) courseId: string;
  @Prop({ required: true }) customerId: string;
  @Prop({ type: Date, default: () => new Date() }) enrolledAt: Date;
  /** lessonId -> { completedAt, score? } */
  @Prop({ type: Object, default: {} }) progress: Record<string, { completedAt: Date; score?: number }>;
  @Prop({ type: Date, default: null }) completedAt: Date | null;
  @Prop({ type: String, default: null }) certificateId: string | null;
}
export const CourseEnrollmentSchema = SchemaFactory.createForClass(CourseEnrollment);
CourseEnrollmentSchema.index({ courseId: 1, customerId: 1 }, { unique: true });
CourseEnrollmentSchema.index({ storeId: 1, customerId: 1 });
CourseEnrollmentSchema.index({ certificateId: 1 }, { unique: true, sparse: true });
