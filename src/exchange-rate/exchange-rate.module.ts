import { Module } from '@nestjs/common';
import { ExchangeRateService } from './exchange-rate.service';
import { ExchangeRateController, AdminFxController } from './exchange-rate.controller';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  // ActivityLogModule is @Global() (see its own module file) so it doesn't
  // need to be re-imported here for ActivityLogService to be injectable.
  imports: [AdminConfigModule, AuthModule],
  controllers: [ExchangeRateController, AdminFxController],
  providers: [ExchangeRateService],
  exports: [ExchangeRateService],
})
export class ExchangeRateModule {}
