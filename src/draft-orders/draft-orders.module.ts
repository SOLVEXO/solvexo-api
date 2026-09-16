import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { EmailService } from '../otp/services/email.service';
import { StripeConnectModule } from '../stripe-connect/stripe-connect.module';
import { DraftOrdersController } from './draft-orders.controller';
import { PublicDraftOrdersController } from './public-draft-orders.controller';
import { DraftOrdersService } from './draft-orders.service';

@Module({
  // ExchangeRateModule — Phase 0 currency normalization: `complete()` needs
  // ExchangeRateService.buildSnapshots to give the resulting Order a real
  // fxSnapshots/ratePerUSD (previously always fxSnapshots: [], the one
  // order-creation path with no FX data at all — see DraftOrdersService).
  // StripeConnectModule — real Connect-routed invoice payments (see
  // DraftOrdersService.createInvoicePaymentIntent). CommissionRulesService
  // is @Global() so it needs no explicit import here.
  imports: [AuthModule, RedisModule, ActivityLogModule, ExchangeRateModule, StripeConnectModule],
  controllers: [DraftOrdersController, PublicDraftOrdersController],
  providers: [DraftOrdersService, EmailService],
  exports: [DraftOrdersService],
})
export class DraftOrdersModule {}
