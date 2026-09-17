import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';
import { PromotionsModule } from '@/promotions/promotions.module';
import { FinanceModule } from '@/finance/finance.module';
import { AdminConfigModule } from '@/admin-config/admin-config.module';
import { ExchangeRateModule } from '@/exchange-rate/exchange-rate.module';
import { GiftCardsModule } from '@/gift-cards/gift-cards.module';
import { StripeConnectModule } from '@/stripe-connect/stripe-connect.module';

@Module({
  // CommissionRulesModule is @Global() (see its own module file) so it
  // doesn't need to be imported here to inject CommissionRulesService.
  imports: [AuthModule, RedisModule, PromotionsModule, FinanceModule, AdminConfigModule, ExchangeRateModule, GiftCardsModule, StripeConnectModule],
  controllers: [PaymentController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
