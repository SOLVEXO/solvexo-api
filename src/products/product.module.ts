import { Module } from '@nestjs/common';
import { productController } from './products.controller';
import { ProductsService } from './products.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';
import { AdminConfigModule } from 'src/admin-config/admin-config.module';




@Module({

   imports: [AuthModule, RedisModule, AdminConfigModule],
  controllers: [ productController],
  providers: [ProductsService ], 
  exports: [ProductsService ], 

})

export class ProductsModule {}