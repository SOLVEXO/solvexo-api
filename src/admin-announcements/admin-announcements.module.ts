import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminAnnouncementsController } from './admin-announcements.controller';
import { PublicAnnouncementsController } from './public-announcements.controller';
import { AdminAnnouncementsService } from './admin-announcements.service';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [AdminAnnouncementsController, PublicAnnouncementsController],
  providers: [AdminAnnouncementsService],
  exports: [AdminAnnouncementsService],
})
export class AdminAnnouncementsModule {}
