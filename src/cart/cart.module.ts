import { Module } from '@nestjs/common';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { AuthModule } from 'src/auth/auth.module';  
import { RedisModule } from 'src/redis/redis.module';  




@Module({
 
   imports: [AuthModule, RedisModule], 
  controllers: [ CartController],
  providers: [CartService], 
  exports: [CartService], 

})

export class CartModule {}