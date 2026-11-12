import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { KhataAccount, KhataAccountSchema, KhataEntry, KhataEntrySchema } from './khata.schema';
import { KhataController } from './khata.controller';
import { KhataService } from './khata.service';
import { KhataRemindersService } from './khata-reminders.service';
import { MessagingChannelsModule } from '../messaging-channels/messaging-channels.module';

@Module({
  imports: [AuthModule, RedisModule, MessagingChannelsModule, MongooseModule.forFeature([{ name: KhataAccount.name, schema: KhataAccountSchema }, { name: KhataEntry.name, schema: KhataEntrySchema }])],
  controllers: [KhataController],
  providers: [KhataService, KhataRemindersService],
  exports: [KhataService],
})
export class KhataModule {}
