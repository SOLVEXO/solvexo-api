import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { CheckoutRulesController, CheckoutRulesStorefrontController } from './checkout-rules.controller';
import { CheckoutRule, CheckoutRuleSchema } from './checkout-rules.schema';
import { CheckoutRulesService } from './checkout-rules.service';

/** Global so checkout / payment / shipping code can inject the evaluator (always `@Optional()`) without module wiring. */
@Global()
@Module({
  imports: [AuthModule, RedisModule, MongooseModule.forFeature([{ name: CheckoutRule.name, schema: CheckoutRuleSchema }])],
  controllers: [CheckoutRulesController, CheckoutRulesStorefrontController],
  providers: [CheckoutRulesService],
  exports: [CheckoutRulesService],
})
export class CheckoutRulesModule {}
