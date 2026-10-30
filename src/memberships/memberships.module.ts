import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AccessPlan, AccessPlanSchema, MemberSubscription, MemberSubscriptionSchema } from './membership.schema';
import { PlatformPlansModule } from '../platform-plans/platform-plans.module';
import { DigitalMailerModule } from '../digital-access/digital-mailer.module';
import { StripeConnectModule } from '../stripe-connect/stripe-connect.module';
import { MembershipsService } from './memberships.service';
import { StripeMembershipProvider } from './stripe-membership.provider';
import { MembershipStripeWebhookService } from './membership-stripe-webhook.service';
import { MembershipBillingProcessor } from './membership-billing.processor';
import { BuyerMembershipsController, MembershipStripeWebhookController, PublicMembershipsController, SellerMembershipsController } from './memberships.controller';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    PlatformPlansModule,
    DigitalMailerModule,
    StripeConnectModule,
    MongooseModule.forFeature([
      { name: AccessPlan.name, schema: AccessPlanSchema },
      { name: MemberSubscription.name, schema: MemberSubscriptionSchema },
    ]),
  ],
  controllers: [PublicMembershipsController, BuyerMembershipsController, SellerMembershipsController, MembershipStripeWebhookController],
  providers: [MembershipsService, StripeMembershipProvider, MembershipStripeWebhookService, MembershipBillingProcessor],
  exports: [MembershipsService],
})
export class MembershipsModule {}
