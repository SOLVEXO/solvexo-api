import { Module } from '@nestjs/common';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
