import { Module } from '@nestjs/common';
import { DigitalAccessModule } from '../digital-access/digital-access.module';
import { productController } from './products.controller';
import { ProductsService } from './products.service';
import { EducationLevelService } from './education-level.service';
import { CatalogIntegrityService } from './catalog-integrity.service';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';
import { AdminConfigModule } from '@/admin-config/admin-config.module';
import { MarketingModule } from '@/marketing/marketing.module';
import { UploadModule } from '@/upload/upload.module';
import { ProductVariantsModule } from '@/product-variants/product-variants.module';

@Module({
  imports: [
    DigitalAccessModule,
    AuthModule,
    RedisModule,
    AdminConfigModule,
    MarketingModule,
    UploadModule,
    ProductVariantsModule,
  ],
  controllers: [productController],
  providers: [ProductsService, EducationLevelService, CatalogIntegrityService],
  exports: [ProductsService],
})
export class ProductsModule {}
