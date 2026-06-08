import { Module } from '@nestjs/common';
import { PaymentProcessingController } from './payment.controller';
import { PaymentProcessingService } from  './payment.service';

@Module({
  controllers: [PaymentProcessingController],
  providers: [PaymentProcessingService],
})
export class PaymentProcessingModule {}
