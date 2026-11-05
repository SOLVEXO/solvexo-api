import { forwardRef, Module } from '@nestjs/common';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';
import { StoreLocationService } from './store-location.service';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';
import { AdminConfigModule } from '@/admin-config/admin-config.module';
import { FinanceModule } from '@/finance/finance.module';
import { InventoryModule } from '@/inventory/inventory.module';
import { PosPlansModule } from '@/pos-plans/pos-plans.module';
import { KybModule } from '@/kyb/kyb.module';
import { PaymentsCoreModule } from '@/payments-core/payments-core.module';
import { PosDeviceService } from './pos-device.service';
import { PosTokenRevocationService } from './pos-token-revocation.service';
import { PosReceiptService } from './pos-receipt.service';
import { PublicReceiptController } from './public-receipt.controller';

@Module({
  imports: [AuthModule, RedisModule, AdminConfigModule, FinanceModule, InventoryModule, PosPlansModule, KybModule, forwardRef(() => PaymentsCoreModule)],
  controllers: [PosController, PublicReceiptController],
  providers: [PosService, StoreLocationService, PosDeviceService, PosTokenRevocationService, PosReceiptService],
  exports: [PosService],
})
export class PosModule {}
