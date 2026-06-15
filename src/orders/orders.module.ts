// import { Module } from '@nestjs/common';
// import { OrdersController } from './orders.controller';
// import { OrdersService } from './orders.service';

// @Module({
//   controllers: [OrdersController],
//   providers: [OrdersService],
// })
// export class OrdersModule {}

import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { AuthModule } from 'src/auth/auth.module';
import { UploadModule } from 'src/upload/upload.module';
import { RedisModule } from 'src/redis/redis.module';


@Module({
  imports: [AuthModule, UploadModule, RedisModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
