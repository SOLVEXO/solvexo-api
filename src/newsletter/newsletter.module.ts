import { Module } from '@nestjs/common';
import { NewsletterService } from './newsletter.service';
import { NewsletterController } from './newsletter.controller';
import { EmailService } from '../otp/services/email.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { MarketingAutomationsModule } from '../marketing-automations/marketing-automations.module';
import { SubscriberListsService } from './subscriber-lists.service';
import { NewsletterBroadcastProcessor } from './newsletter-broadcast.processor';
import {
  AdminNewsletterController,
  StoreSubscribersController,
} from './subscriber-lists.controller';

// The subscriber model itself is registered in the global DatabaseModule so
// EmailCampaignsService/StoreService can read the same consent rows.
// AuthModule + RedisModule are required by the JWT guards.
// MarketingAutomationsModule sends a store's (seller-configured) welcome email.
@Module({
  imports: [AuthModule, RedisModule, MarketingAutomationsModule],
  controllers: [
    NewsletterController,
    StoreSubscribersController,
    AdminNewsletterController,
  ],
  providers: [NewsletterService, SubscriberListsService, NewsletterBroadcastProcessor, EmailService],
  exports: [NewsletterService],
})
export class NewsletterModule {}
