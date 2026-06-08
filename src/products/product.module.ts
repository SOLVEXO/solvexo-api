import { Module } from '@nestjs/common';
import { productController } from './products.controller';
import { ProductsService } from './products.service';
import { AuthModule } from 'src/auth/auth.module';  
import { RedisModule } from 'src/redis/redis.module';  




@Module({
 
   imports: [AuthModule, RedisModule], 
  controllers: [ productController],
  providers: [ProductsService ], 
  exports: [ProductsService ], 

})

export class ProductsModule {}