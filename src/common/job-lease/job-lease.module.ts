/* eslint-disable prettier/prettier */
import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JobLease, JobLeaseSchema } from './job-lease.schema';
import { JobLeaseService } from './job-lease.service';

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: JobLease.name, schema: JobLeaseSchema }])],
  providers: [JobLeaseService],
  exports: [JobLeaseService],
})
export class JobLeaseModule {}
