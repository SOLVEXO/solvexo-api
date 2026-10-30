import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AccessPlan, AccessPlanSchema, MemberSubscription, MemberSubscriptionSchema } from './membership.schema';
import { PlatformPlansModule } from '../platform-plans/platform-plans.module';
import { MembershipsService } from './memberships.service';
import { BuyerMembershipsController, PublicMembershipsController, SellerMembershipsController } from './memberships.controller';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    PlatformPlansModule,
    MongooseModule.forFeature([
      { name: AccessPlan.name, schema: AccessPlanSchema },
      { name: MemberSubscription.name, schema: MemberSubscriptionSchema },
    ]),
  ],
  controllers: [PublicMembershipsController, BuyerMembershipsController, SellerMembershipsController],
  providers: [MembershipsService],
  exports: [MembershipsService],
})
export class MembershipsModule {}
