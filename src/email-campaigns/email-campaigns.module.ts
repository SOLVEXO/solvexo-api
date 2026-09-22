/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { EmailCampaignsController } from './email-campaigns.controller';
import { EmailCampaignsService } from './email-campaigns.service';
import { EmailCampaignsProcessor } from './email-campaigns.processor';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { EmailService } from '../otp/services/email.service';
import { PlatformPlansModule } from '../platform-plans/platform-plans.module';

// RedisModule alongside AuthModule — required by every module whose
// controller uses JwtAuthGuard (see GiftCardsModule's own doc comment).
// The EMAIL_CAMPAIGNS queue itself is registered centrally in the @Global()
// QueueModule (same as SUBSCRIPTION_EMAILS/NOTIFICATIONS) — this module just
// injects it (in EmailCampaignsService) and runs the worker
// (EmailCampaignsProcessor), it does not re-register the queue.
// PlatformPlansModule for EntitlementsService — executeSend() gates on
// emailCampaignsAllowed.
@Module({
  imports: [AuthModule, RedisModule, PlatformPlansModule],
  controllers: [EmailCampaignsController],
  providers: [EmailCampaignsService, EmailCampaignsProcessor, EmailService],
  exports: [EmailCampaignsService],
})
export class EmailCampaignsModule {}
