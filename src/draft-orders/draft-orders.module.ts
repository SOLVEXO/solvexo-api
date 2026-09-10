import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { DraftOrdersController } from './draft-orders.controller';
import { DraftOrdersService } from './draft-orders.service';

@Module({
  imports: [AuthModule, RedisModule, ActivityLogModule],
  controllers: [DraftOrdersController],
  providers: [DraftOrdersService],
})
export class DraftOrdersModule {}
