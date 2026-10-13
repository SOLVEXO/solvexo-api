import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StoreContactController, PublicStoreContactController } from './store-contact.controller';
import { StoreContactService } from './store-contact.service';

@Module({
  imports: [AuthModule, RedisModule, NotificationsModule],
  controllers: [StoreContactController, PublicStoreContactController],
  providers: [StoreContactService],
  exports: [StoreContactService],
})
export class StoreContactModule {}
