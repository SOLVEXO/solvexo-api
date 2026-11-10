import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { PublicSellingPlansController, SellingPlansController, SubscriptionsStorefrontController } from './selling-plans.controller';
import { SellingPlanGroup, SellingPlanGroupSchema, SubscriptionContract, SubscriptionContractSchema, SubscriptionCycle, SubscriptionCycleSchema } from './selling-plan.schema';
import { SellingPlansService } from './selling-plans.service';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    MongooseModule.forFeature([
      { name: SellingPlanGroup.name, schema: SellingPlanGroupSchema },
      { name: SubscriptionContract.name, schema: SubscriptionContractSchema },
      { name: SubscriptionCycle.name, schema: SubscriptionCycleSchema },
    ]),
  ],
  controllers: [SellingPlansController, SubscriptionsStorefrontController, PublicSellingPlansController],
  providers: [SellingPlansService],
  exports: [SellingPlansService],
})
export class SellingPlansModule {}
