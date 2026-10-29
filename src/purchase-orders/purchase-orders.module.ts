import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrderDocumentsModule } from '../order-documents/order-documents.module';
import { EmailService } from '../otp/services/email.service';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { SupplierReturnsService } from './supplier-returns.service';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    ActivityLogModule,
    InventoryModule,
    NotificationsModule,
    OrderDocumentsModule,
  ],
  controllers: [PurchaseOrdersController],
  // EmailService is provided per-module everywhere in this app (see
  // analytics/draft-orders modules) — PO PDFs go out to suppliers with it.
  providers: [PurchaseOrdersService, SupplierReturnsService, EmailService],
  // Exported so SchedulerModule (the daily overdue-PO-alert cron job) can
  // inject PurchaseOrdersService directly instead of duplicating its logic.
  exports: [PurchaseOrdersService],
})
export class PurchaseOrdersModule {}
