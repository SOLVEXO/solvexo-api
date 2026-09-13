import { Module } from '@nestjs/common';
import { RefundRequestController } from './refund-request.controller';
import { RefundRequestService } from './refund-request.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { FinanceModule } from '../finance/finance.module';
import { PaymentModule } from '../payment/payment.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';

@Module({
  imports: [AuthModule, RedisModule, FinanceModule, PaymentModule, ExchangeRateModule, GiftCardsModule],
  controllers: [RefundRequestController],
  providers: [RefundRequestService],
  exports: [RefundRequestService],
})
export class RefundRequestModule {}
