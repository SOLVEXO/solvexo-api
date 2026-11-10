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
import { PosCatalogService } from './pos-catalog.service';
import { PublicReceiptController } from './public-receipt.controller';
import { StockCountsModule } from '@/stock-counts/stock-counts.module';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosInventoryService } from './pos-inventory.service';
import { PosInventoryController } from './pos-inventory.controller';
import { PosCustomerCore } from './pos-customer-core.service';
import { PosCustomersService } from './pos-customers.service';
import { PosCustomersController } from './pos-customers.controller';
import { PosSupplyService } from './pos-supply.service';
import { PosCashService } from './pos-cash.service';
import { PosTeamService } from './pos-team.service';
import { PosTeamController } from './pos-team.controller';
import { PosReportsService } from './pos-reports.service';
import { PosPermissionsStoreService } from './pos-permissions-store.service';
import { PosPermissionsStoreController } from './pos-permissions-store.controller';
import { PosAuditSealService } from './pos-audit-seal.service';
import { PosAuditController } from './pos-audit.controller';
import { PosReportsController, PosStoreController } from './pos-reports.controller';
import { PosCashController } from './pos-cash.controller';
import { UploadModule } from '@/upload/upload.module';
import { PosSupplyController } from './pos-supply.controller';
import { PurchaseOrdersModule } from '@/purchase-orders/purchase-orders.module';

@Module({
  imports: [AuthModule, RedisModule, AdminConfigModule, FinanceModule, InventoryModule, PurchaseOrdersModule, UploadModule, StockCountsModule, PosPlansModule, KybModule, forwardRef(() => PaymentsCoreModule)],
  controllers: [PosController, PublicReceiptController, PosInventoryController, PosCustomersController, PosSupplyController, PosCashController, PosTeamController, PosReportsController, PosStoreController, PosPermissionsStoreController, PosAuditController],
  providers: [PosService, StoreLocationService, PosDeviceService, PosTokenRevocationService, PosReceiptService, PosCatalogService, PosAuthorizer, PosInventoryService, PosCustomerCore, PosCustomersService, PosSupplyService, PosCashService, PosTeamService, PosReportsService, PosPermissionsStoreService, PosAuditSealService],
  exports: [PosService, PosAuthorizer],
})
export class PosModule {}
