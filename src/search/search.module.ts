import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';
import { ProductsModule } from '@/products/product.module';
import { StoreModule } from '@/store/store.module';

@Module({
  // RedisModule is required by JwtAuthGuard/OptionalJwtAuthGuard (session
  // check) — guards resolve DI from the consuming module's context.
  imports: [AuthModule, RedisModule, ProductsModule, StoreModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
