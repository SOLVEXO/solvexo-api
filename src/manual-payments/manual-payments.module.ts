/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { UploadModule } from '../upload/upload.module';
import { PaymentModule } from '../payment/payment.module';
import { FinanceModule } from '../finance/finance.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { ManualPaymentsController } from './manual-payments.controller';
import { SellerManualPaymentsController } from './seller-manual-payments.controller';
import { ManualPaymentsService } from './manual-payments.service';

@Module({
  imports: [AuthModule, RedisModule, UploadModule, PaymentModule, FinanceModule, ExchangeRateModule],
  controllers: [ManualPaymentsController, SellerManualPaymentsController],
  providers: [ManualPaymentsService],
  exports: [ManualPaymentsService],
})
export class ManualPaymentsModule {}
