/* eslint-disable prettier/prettier */
import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { PlatformTaxController } from './platform-tax.controller';
import { PlatformTaxService } from './platform-tax.service';
import { PlatformTaxQuoteController } from './platform-tax-quote.controller';
import { PlatformTaxSettings, PlatformTaxSettingsSchema } from './schemas/platform-tax-settings.schema';
import { PlatformTaxRecord, PlatformTaxRecordSchema } from './schemas/platform-tax-record.schema';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PlatformTaxSettings.name, schema: PlatformTaxSettingsSchema },
      { name: PlatformTaxRecord.name, schema: PlatformTaxRecordSchema },
    ]),
    // RedisModule: JwtAuthGuard injects RedisService, which only resolves when this module imports it (AuthModule
    // doesn't re-export it). Without it every admin tax route returned 500 "reading 'isConnected'".
    AuthModule, RedisModule, SubscriptionsModule, ExchangeRateModule,
  ],
  controllers: [PlatformTaxController, PlatformTaxQuoteController],
  providers: [PlatformTaxService],
  exports: [PlatformTaxService],
})
export class PlatformTaxModule {}
