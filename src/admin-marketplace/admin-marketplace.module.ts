import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { UploadModule } from '../upload/upload.module';
import { StoreModule } from '../store/store.module';
import { AdminMarketplaceController } from './admin-marketplace.controller';
import { AdminMarketplaceService } from './admin-marketplace.service';

@Module({
  imports: [AuthModule, RedisModule, UploadModule, StoreModule],
  controllers: [AdminMarketplaceController],
  providers: [AdminMarketplaceService],
  exports: [AdminMarketplaceService],
})
export class AdminMarketplaceModule {}
