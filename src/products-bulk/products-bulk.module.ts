/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ProductVariantsModule } from '../product-variants/product-variants.module';
import { ProductsBulkController } from './products-bulk.controller';
import { ProductsBulkService } from './products-bulk.service';

@Module({
  imports: [AuthModule, RedisModule, ProductVariantsModule],
  controllers: [ProductsBulkController],
  providers: [ProductsBulkService],
})
export class ProductsBulkModule {}
