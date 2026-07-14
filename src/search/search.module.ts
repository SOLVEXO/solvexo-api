/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';
import { ProductsModule } from 'src/products/product.module';

@Module({
  // RedisModule is required by JwtAuthGuard/OptionalJwtAuthGuard (session
  // check) — guards resolve DI from the consuming module's context.
  imports: [AuthModule, RedisModule, ProductsModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
