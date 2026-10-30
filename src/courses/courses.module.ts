import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { UploadModule } from '../upload/upload.module';
import { DigitalAccessModule } from '../digital-access/digital-access.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { Course, CourseSchema, CourseEnrollment, CourseEnrollmentSchema } from './course.schema';
import { CoursesService } from './courses.service';
import { LearnerCoursesController, PublicCertificateController, SellerCoursesController } from './courses.controller';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    UploadModule,
    DigitalAccessModule,
    MembershipsModule,
    MongooseModule.forFeature([
      { name: Course.name, schema: CourseSchema },
      { name: CourseEnrollment.name, schema: CourseEnrollmentSchema },
    ]),
  ],
  controllers: [PublicCertificateController, LearnerCoursesController, SellerCoursesController],
  providers: [CoursesService],
  exports: [CoursesService],
})
export class CoursesModule {}
