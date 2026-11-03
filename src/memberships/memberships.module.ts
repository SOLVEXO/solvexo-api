import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AccessPlan, AccessPlanSchema, MemberSubscription, MemberSubscriptionSchema } from './membership.schema';
import { RenewalInvoice, RenewalInvoiceSchema } from './renewal-invoice.schema';
import { RenewalInvoicesService } from './renewal-invoices.service';
import { BuyerRenewalInvoicesController, SellerRenewalInvoicesController } from './renewal-invoices.controller';
import { UploadModule } from '../upload/upload.module';
import { PlatformPlansModule } from '../platform-plans/platform-plans.module';
import { DigitalMailerModule } from '../digital-access/digital-mailer.module';
import { StripeConnectModule } from '../stripe-connect/stripe-connect.module';
import { MembershipsService } from './memberships.service';
import { StripeMembershipProvider } from './stripe-membership.provider';
import { SafepayMembershipProvider } from './safepay-membership.provider';
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
    UploadModule,
    MongooseModule.forFeature([
      { name: AccessPlan.name, schema: AccessPlanSchema },
      { name: MemberSubscription.name, schema: MemberSubscriptionSchema },
      { name: RenewalInvoice.name, schema: RenewalInvoiceSchema },
    ]),
  ],
  controllers: [PublicMembershipsController, BuyerMembershipsController, SellerMembershipsController, MembershipStripeWebhookController, BuyerRenewalInvoicesController, SellerRenewalInvoicesController],
  providers: [MembershipsService, RenewalInvoicesService, StripeMembershipProvider, SafepayMembershipProvider, MembershipStripeWebhookService, MembershipBillingProcessor],
  exports: [MembershipsService, RenewalInvoicesService],
})
export class MembershipsModule {}
