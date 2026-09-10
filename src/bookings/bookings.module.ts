/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { BookingsController } from './bookings.controller';
import { BookableServicesService } from './bookable-services.service';
import { BookingsService } from './bookings.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { FinanceModule } from '../finance/finance.module';

// RedisModule is imported alongside AuthModule per this codebase's recurring
// bug note: any new module using JwtAuthGuard must also import RedisModule
// or guarded routes 500 at runtime. PaymentGatewayService is injected
// straight from the @Global() SubscriptionsModule (no import needed here).
@Module({
  imports: [AuthModule, RedisModule, FinanceModule],
  controllers: [BookingsController],
  providers: [BookableServicesService, BookingsService],
  // Exported so SchedulerModule can inject BookingsService for the
  // completePastBookings/expirePackagePurchases/sendBookingReminders cron jobs.
  exports: [BookingsService],
})
export class BookingsModule {}
