import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';

@Module({
  imports: [AuthModule, RedisModule, ActivityLogModule, InventoryModule, NotificationsModule],
  controllers: [PurchaseOrdersController],
  providers: [PurchaseOrdersService],
  // Exported so SchedulerModule (the daily overdue-PO-alert cron job) can
  // inject PurchaseOrdersService directly instead of duplicating its logic.
  exports: [PurchaseOrdersService],
})
export class PurchaseOrdersModule {}
