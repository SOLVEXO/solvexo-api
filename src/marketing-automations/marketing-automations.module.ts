/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { PlatformPlansModule } from '../platform-plans/platform-plans.module';
import { EmailService } from '../otp/services/email.service';
import { MarketingAutomationsController } from './marketing-automations.controller';
import { MarketingAutomationsService } from './marketing-automations.service';

// Schemas are registered in the global DatabaseModule. RedisModule + AuthModule
// for the JWT guards; PlatformPlansModule for EntitlementsService (price drop
// and win-back are gated on the same emailCampaignsAllowed plan feature as
// campaigns). The crons live in SchedulerService, which imports this module.
@Module({
  imports: [AuthModule, RedisModule, PlatformPlansModule],
  controllers: [MarketingAutomationsController],
  providers: [MarketingAutomationsService, EmailService],
  exports: [MarketingAutomationsService],
})
export class MarketingAutomationsModule {}
