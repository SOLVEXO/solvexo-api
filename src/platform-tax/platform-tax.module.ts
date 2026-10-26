/* eslint-disable prettier/prettier */
import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
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
    AuthModule, SubscriptionsModule, ExchangeRateModule,
  ],
  controllers: [PlatformTaxController, PlatformTaxQuoteController],
  providers: [PlatformTaxService],
  exports: [PlatformTaxService],
})
export class PlatformTaxModule {}
