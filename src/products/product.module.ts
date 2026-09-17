import { Module } from '@nestjs/common';
import { productController } from './products.controller';
import { ProductsService } from './products.service';
import { EducationLevelService } from './education-level.service';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';
import { AdminConfigModule } from '@/admin-config/admin-config.module';
import { MarketingModule } from '@/marketing/marketing.module';
import { UploadModule } from '@/upload/upload.module';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    AdminConfigModule,
    MarketingModule,
    UploadModule,
  ],
  controllers: [productController],
  providers: [ProductsService, EducationLevelService],
  exports: [ProductsService],
})
export class ProductsModule {}
