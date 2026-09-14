import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuthModule, DatabaseModule, RedisModule, NotificationsModule],
  controllers: [InventoryController],
  providers: [InventoryService],
  // Exported so PurchaseOrdersModule (receiving reuses the exact same
  // location-stock-seeding helper as Inventory's own Adjust/Transfer) and
  // any future module can inject InventoryService instead of duplicating
  // its stock-mutation logic.
  exports: [InventoryService],
})
export class InventoryModule {}
