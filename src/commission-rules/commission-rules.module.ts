/* eslint-disable prettier/prettier */
import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { CommissionRulesController } from './commission-rules.controller';
import { CommissionRulesService } from './commission-rules.service';

// @Global() so Finance/AdminFinance (and any future module needing the
// resolved commission rate) can inject CommissionRulesService without
// importing this module explicitly — identical reasoning to why
// PlatformPlansModule/ActivityLogModule are global.
@Global()
@Module({
  imports: [AuthModule, RedisModule],
  controllers: [CommissionRulesController],
  providers: [CommissionRulesService],
  exports: [CommissionRulesService],
})
export class CommissionRulesModule {}
