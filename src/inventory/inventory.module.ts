import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';


@Module({
  imports: [AuthModule, DatabaseModule, RedisModule],
  controllers: [InventoryController],
  providers: [InventoryService],
})
export class InventoryModule {}
