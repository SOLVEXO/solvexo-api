/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { SalesRepAccess, SalesRepAccessSchema } from './schemas/sales-rep-access.schema';
import { SalesAccessService } from './sales-access.service';
import { SalesWhatsAppService } from './sales-whatsapp.service';
import { SalesBrevoService } from './sales-brevo.service';
import {
  SalesWaConversation,
  SalesWaConversationSchema,
} from './schemas/sales-wa-conversation.schema';
import {
  SalesWaMessage,
  SalesWaMessageSchema,
} from './schemas/sales-wa-message.schema';
import { SalesAgentService } from './sales-agent.service';
import { AiTextModule } from '../ai/ai-text.module';
import {
  SalesChatSession,
  SalesChatSessionSchema,
} from './schemas/sales-chat-session.schema';
import { SalesPartnersService } from './sales-partners.service';
import { PartnerOnboardingService } from './partner-onboarding.service';
import { PartnerApplyController, PartnerPortalDealsController, PartnerPortalScorecardController, PartnerPortalOnboardingController, PartnerProgrammeController } from './partner-programme.controller';
import { PartnerDealsService } from './partner-deals.service';
import { PartnerScorecardService } from './partner-scorecard.service';
import { PartnerLog, PartnerLogSchema } from './schemas/partner-log.schema';
import { PartnerDeal, PartnerDealSchema } from './schemas/partner-deal.schema';
import { PartnerProgrammeSettings, PartnerProgrammeSettingsSchema } from './schemas/partner-programme-settings.schema';
import { AdminTeamModule } from '../admin-team/admin-team.module';
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
import { SalesVisit, SalesVisitSchema } from './schemas/sales-visit.schema';
import { SalesVisitsService } from './sales-visits.service';
import { UploadModule } from '../upload/upload.module';
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
    AiTextModule,
    UploadModule,
    AdminTeamModule,
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
      { name: PartnerProgrammeSettings.name, schema: PartnerProgrammeSettingsSchema },
      { name: PartnerDeal.name, schema: PartnerDealSchema },
      { name: PartnerLog.name, schema: PartnerLogSchema },
      { name: SalesChatSession.name, schema: SalesChatSessionSchema },
      { name: SalesWaConversation.name, schema: SalesWaConversationSchema },
      { name: SalesWaMessage.name, schema: SalesWaMessageSchema },
      { name: SalesVisit.name, schema: SalesVisitSchema },
      { name: SalesRepAccess.name, schema: SalesRepAccessSchema },
    ]),
  ],
  controllers: [
    SalesOpsController,
    SalesPublicController,
    PartnerPortalController,
    PartnerApplyController,
    PartnerProgrammeController,
    PartnerPortalOnboardingController,
    PartnerPortalDealsController,
    PartnerPortalScorecardController,
  ],
  providers: [
    SalesAccessService,
    SalesOpsService,
    SalesCaptureService,
    SalesGrowthService,
    SalesPartnersService,
    PartnerOnboardingService,
    PartnerDealsService,
    PartnerScorecardService,
    SalesAgentService,
    SalesWhatsAppService,
    SalesBrevoService,
    SalesVisitsService,
    EmailService,
  ],
  exports: [SalesOpsService, SalesCaptureService],
})
export class SalesOpsModule {}
