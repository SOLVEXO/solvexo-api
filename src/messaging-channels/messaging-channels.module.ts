import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { CustomerSegmentsModule } from '../customer-segments/customer-segments.module';
import {
  MessagingCampaign, MessagingCampaignSchema, MessagingConsent, MessagingConsentSchema, MessagingMessage, MessagingMessageSchema, SmsGatewayConfig, SmsGatewayConfigSchema, WhatsAppTemplate, WhatsAppTemplateSchema,
} from './messaging.schema';
import { SmsGatewayService } from './sms-gateway.service';
import { PublicSmsController } from './public-sms.controller';
import { MessagingConsentService } from './messaging-consent.service';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';
import { MessagingCampaignsService } from './messaging-campaigns.service';
import { MessagingWebhookService } from './messaging-webhook.service';
import { MessagingSendProcessor } from './messaging-send.processor';
import { MessagingController } from './messaging.controller';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    CustomerSegmentsModule,
    MongooseModule.forFeature([
      { name: MessagingConsent.name, schema: MessagingConsentSchema },
      { name: WhatsAppTemplate.name, schema: WhatsAppTemplateSchema },
      { name: MessagingCampaign.name, schema: MessagingCampaignSchema },
      { name: MessagingMessage.name, schema: MessagingMessageSchema },
      { name: SmsGatewayConfig.name, schema: SmsGatewayConfigSchema },
    ]),
  ],
  controllers: [MessagingController, PublicSmsController],
  providers: [SmsGatewayService, MessagingConsentService, WhatsAppTemplatesService, MessagingCampaignsService, MessagingWebhookService, MessagingSendProcessor],
  exports: [MessagingConsentService, MessagingCampaignsService],
})
export class MessagingChannelsModule {}
