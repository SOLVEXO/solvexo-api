/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { EmailService } from '../otp/services/email.service';
import {
  SalesOpsController,
  SalesPublicController,
} from './sales-ops.controller';
import { SalesCaptureService } from './sales-capture.service';
import { SalesGrowthService } from './sales-growth.service';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import {
  SalesCampaign,
  SalesCampaignSchema,
} from './schemas/sales-campaign.schema';
import { SalesTarget, SalesTargetSchema } from './schemas/sales-target.schema';
import {
  SalesSettings,
  SalesSettingsSchema,
} from './schemas/sales-settings.schema';
import { AdminAnalyticsModule } from '../admin-analytics/admin-analytics.module';
import {
  ContactSubmission,
  ContactSubmissionSchema,
} from '../contact/schemas/contact-submission.schema';
import { SalesOpsService } from './sales-ops.service';
import { SalesLead, SalesLeadSchema } from './schemas/sales-lead.schema';
import {
  SalesActivity,
  SalesActivitySchema,
} from './schemas/sales-activity.schema';
import { SalesTask, SalesTaskSchema } from './schemas/sales-task.schema';
import {
  SalesEmailTemplate,
  SalesEmailTemplateSchema,
} from './schemas/sales-email-template.schema';

// RedisModule is needed by JwtAuthGuard (see common/module-redis-import.spec.ts).
@Module({
  imports: [
    AuthModule,
    RedisModule,
    AdminAnalyticsModule,
    ExchangeRateModule,
    MongooseModule.forFeature([
      { name: SalesLead.name, schema: SalesLeadSchema },
      { name: SalesActivity.name, schema: SalesActivitySchema },
      { name: SalesTask.name, schema: SalesTaskSchema },
      { name: SalesEmailTemplate.name, schema: SalesEmailTemplateSchema },
      { name: ContactSubmission.name, schema: ContactSubmissionSchema },
      { name: SalesCampaign.name, schema: SalesCampaignSchema },
      { name: SalesTarget.name, schema: SalesTargetSchema },
      { name: SalesSettings.name, schema: SalesSettingsSchema },
    ]),
  ],
  controllers: [SalesOpsController, SalesPublicController],
  providers: [
    SalesOpsService,
    SalesCaptureService,
    SalesGrowthService,
    EmailService,
  ],
  exports: [SalesOpsService, SalesCaptureService],
})
export class SalesOpsModule {}
