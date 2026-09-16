/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';
import { ProductViewsController } from './product-views.controller';
import { ProductViewsService } from './product-views.service';

@Module({
  // RedisModule is required by OptionalJwtAuthGuard (session check) — guards
  // resolve DI from the consuming module's context, same as SearchModule.
  imports: [AuthModule, RedisModule],
  controllers: [ProductViewsController],
  providers: [ProductViewsService],
  exports: [ProductViewsService],
})
export class ProductViewsModule {}
