import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { StoreModule } from '../store/store.module';
import { AdminMarketplaceModule } from '../admin-marketplace/admin-marketplace.module';
import { SellerTrustModule } from '../seller-trust/seller-trust.module';
import { AdminSellerTrustController } from './admin-seller-trust.controller';
import { AdminSellerTrustService } from './admin-seller-trust.service';

@Module({
  // RedisModule — JwtAuthGuard needs RedisService (see AdminClientsModule's note).
  imports: [AuthModule, RedisModule, AdminConfigModule, StoreModule, AdminMarketplaceModule, SellerTrustModule],
  controllers: [AdminSellerTrustController],
  providers: [AdminSellerTrustService],
  exports: [AdminSellerTrustService],
})
export class AdminSellerTrustModule {}
