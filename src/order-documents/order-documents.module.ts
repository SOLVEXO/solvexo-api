/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { OrderDocumentsController } from './order-documents.controller';
import { OrderDocumentsService } from './order-documents.service';

// AuthModule + RedisModule: JwtAuthGuard needs them (see NotificationsModule's note).
@Module({
  imports: [AuthModule, RedisModule],
  controllers: [OrderDocumentsController],
  providers: [OrderDocumentsService],
  // Purchase orders print with the same branding as this store's invoices,
  // so PurchaseOrdersModule reads the settings through this service.
  exports: [OrderDocumentsService],
})
export class OrderDocumentsModule {}
