import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { StripeConnectModule } from '../stripe-connect/stripe-connect.module';

@Module({
  // StripeConnectModule has no dependency back on FinanceModule (checked —
  // it only imports AuthModule/RedisModule), so this stays a one-directional
  // edge: FinanceService calls StripeConnectService to actually move money
  // for a payout; StripeConnectService never needs to know about Finance.
  imports: [AuthModule, RedisModule, AdminConfigModule, StripeConnectModule],
  controllers: [FinanceController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
