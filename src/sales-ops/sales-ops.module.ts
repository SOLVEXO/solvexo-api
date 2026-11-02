/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { SalesAgentService } from './sales-agent.service';
import { AiStudioModule } from '../ai-studio/ai-studio.module';
import {
  SalesChatSession,
  SalesChatSessionSchema,
} from './schemas/sales-chat-session.schema';
import { SalesPartnersService } from './sales-partners.service';
import {
  SalesPartner,
  SalesPartnerSchema,
} from './schemas/sales-partner.schema';
import {
  SalesCommissionPlan,
  SalesCommissionPlanSchema,
} from './schemas/sales-commission-plan.schema';
import {
  SalesPartnerReferral,
  SalesPartnerReferralSchema,
} from './schemas/sales-partner-referral.schema';
import {
  SalesCommission,
  SalesCommissionSchema,
} from './schemas/sales-commission.schema';
import { SalesPayout, SalesPayoutSchema } from './schemas/sales-payout.schema';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { EmailService } from '../otp/services/email.service';
import {
  PartnerPortalController,
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
    AiStudioModule,
    MongooseModule.forFeature([
      { name: SalesLead.name, schema: SalesLeadSchema },
      { name: SalesActivity.name, schema: SalesActivitySchema },
      { name: SalesTask.name, schema: SalesTaskSchema },
      { name: SalesEmailTemplate.name, schema: SalesEmailTemplateSchema },
      { name: ContactSubmission.name, schema: ContactSubmissionSchema },
      { name: SalesCampaign.name, schema: SalesCampaignSchema },
      { name: SalesTarget.name, schema: SalesTargetSchema },
      { name: SalesSettings.name, schema: SalesSettingsSchema },
      { name: SalesPartner.name, schema: SalesPartnerSchema },
      { name: SalesCommissionPlan.name, schema: SalesCommissionPlanSchema },
      { name: SalesPartnerReferral.name, schema: SalesPartnerReferralSchema },
      { name: SalesCommission.name, schema: SalesCommissionSchema },
      { name: SalesPayout.name, schema: SalesPayoutSchema },
      { name: SalesChatSession.name, schema: SalesChatSessionSchema },
    ]),
  ],
  controllers: [
    SalesOpsController,
    SalesPublicController,
    PartnerPortalController,
  ],
  providers: [
    SalesOpsService,
    SalesCaptureService,
    SalesGrowthService,
    SalesPartnersService,
    SalesAgentService,
    EmailService,
  ],
  exports: [SalesOpsService, SalesCaptureService],
})
export class SalesOpsModule {}
