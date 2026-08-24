/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { ContentVersioningService } from './content-versioning.service';

@Module({
  providers: [ContentVersioningService],
  exports: [ContentVersioningService],
})
export class ContentVersioningModule {}
