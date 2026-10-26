import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { StoreChatSettings, StoreChatSettingsSchema } from './store-chat-settings.schema';
import { StoreChatSettingsController } from './store-chat-settings.controller';
import { PublicStoreChatSettingsController } from './public-store-chat-settings.controller';
import { StoreChatSettingsService } from './store-chat-settings.service';

@Module({
  imports: [AuthModule, RedisModule, MongooseModule.forFeature([{ name: StoreChatSettings.name, schema: StoreChatSettingsSchema }])],
  controllers: [StoreChatSettingsController, PublicStoreChatSettingsController],
  providers: [StoreChatSettingsService],
})
export class StoreChatSettingsModule {}
