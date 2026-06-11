// import { Module } from '@nestjs/common';
// import { PaymentProcessingController } from './payment.controller';
// import { PaymentProcessingService } from  './payment.service';

// @Module({
//   controllers: [PaymentProcessingController],
//   providers: [PaymentProcessingService],
// })
// export class PaymentProcessingModule {}

import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [PaymentController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
