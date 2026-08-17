import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';
import { PromotionsModule } from 'src/promotions/promotions.module';
import { FinanceModule } from 'src/finance/finance.module';
import { AdminConfigModule } from 'src/admin-config/admin-config.module';
import { ExchangeRateModule } from 'src/exchange-rate/exchange-rate.module';

@Module({
  imports: [AuthModule, RedisModule, PromotionsModule, FinanceModule, AdminConfigModule, ExchangeRateModule],
  controllers: [PaymentController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
