/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { B2BCompany, B2BCompanySchema } from '../b2b/b2b.schema';
import { FbrDiSettings, FbrDiSettingsSchema, FbrInvoiceRecord, FbrInvoiceSchema, StoreFbrSettings, StoreFbrSettingsSchema } from './fbr-di.schemas';
import { AdminFbrDiController, StoreFbrDiController } from './fbr-di.controller';
import { FbrDiService } from './fbr-di.service';
import { FbrDiClient } from './fbr-di.client';

// JwtAuthGuard needs RedisModule + AuthModule here (same as every module that uses it).
// PlatformTaxModule and NotificationsModule are global, ActivityLog/Database come from their own global modules.
@Module({
  imports: [
    AuthModule, RedisModule, ExchangeRateModule,
    MongooseModule.forFeature([
      { name: FbrDiSettings.name, schema: FbrDiSettingsSchema },
      { name: StoreFbrSettings.name, schema: StoreFbrSettingsSchema },
      { name: FbrInvoiceRecord.name, schema: FbrInvoiceSchema },
      // Read-only: a wholesale order's company (its tax ID) for the buyer on the invoice.
      { name: B2BCompany.name, schema: B2BCompanySchema },
    ]),
  ],
  controllers: [AdminFbrDiController, StoreFbrDiController],
  providers: [FbrDiService, FbrDiClient],
  exports: [FbrDiService],
})
export class FbrDiModule {}
