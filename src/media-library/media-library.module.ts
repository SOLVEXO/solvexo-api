import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { UploadModule } from '../upload/upload.module';
import { MediaLibraryController } from './media-library.controller';
import { MediaLibraryService } from './media-library.service';

@Module({
  imports: [AuthModule, RedisModule, UploadModule],
  controllers: [MediaLibraryController],
  providers: [MediaLibraryService],
  exports: [MediaLibraryService],
})
export class MediaLibraryModule {}
