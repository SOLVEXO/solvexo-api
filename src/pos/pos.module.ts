import { Module } from '@nestjs/common';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';
import { StoreLocationService } from './store-location.service';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';
import { AdminConfigModule } from '@/admin-config/admin-config.module';
import { FinanceModule } from '@/finance/finance.module';
import { InventoryModule } from '@/inventory/inventory.module';
import { PosPlansModule } from '@/pos-plans/pos-plans.module';
import { PosDeviceService } from './pos-device.service';
import { PosTokenRevocationService } from './pos-token-revocation.service';

@Module({
  imports: [AuthModule, RedisModule, AdminConfigModule, FinanceModule, InventoryModule, PosPlansModule],
  controllers: [PosController],
  providers: [PosService, StoreLocationService, PosDeviceService, PosTokenRevocationService],
})
export class PosModule {}
