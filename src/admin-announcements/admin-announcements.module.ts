import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminAnnouncementsController } from './admin-announcements.controller';
import { AdminAnnouncementsService } from './admin-announcements.service';

@Module({
  imports: [AuthModule, RedisModule, NotificationsModule],
  controllers: [AdminAnnouncementsController],
  providers: [AdminAnnouncementsService],
  exports: [AdminAnnouncementsService],
})
export class AdminAnnouncementsModule {}
