/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { B2BCompany, B2BCompanySchema } from '../b2b/b2b.schema';
import { FbrDiSettings, FbrDiSettingsSchema, StoreFbrSettings, StoreFbrSettingsSchema } from './fbr-di.schemas';
import { PlatformEinvoiceRecord, PlatformEinvoiceSchema, StoreEinvoiceRecord, StoreEinvoiceSchema } from './einvoice-record.schemas';
import { PlatformInvoice, PlatformInvoiceSchema } from '../platform-tax/schemas/platform-invoice.schema';
import { AdminFbrDiController, StoreFbrDiController } from './fbr-di.controller';
import { FbrDiService } from './fbr-di.service';
import { FbrDiClient } from './fbr-di.client';
import { PlatformEinvoiceService, StoreEinvoiceService } from './einvoice-scoped.services';
import { TaxAuthorityRegistry } from '../tax-core/tax-authority.registry';
import { PkFbrAdapter } from '../tax-authorities/pk-fbr/pk-fbr.adapter';

// JwtAuthGuard needs RedisModule + AuthModule here (same as every module that uses it).
// PlatformTaxModule and NotificationsModule are global, ActivityLog/Database come from their own global modules.
@Module({
  imports: [
    AuthModule, RedisModule, ExchangeRateModule,
    MongooseModule.forFeature([
      { name: FbrDiSettings.name, schema: FbrDiSettingsSchema },
      { name: StoreFbrSettings.name, schema: StoreFbrSettingsSchema },
      // Two separate record collections: Solvexo's own invoices and a seller's own sales are never in the same one.
      { name: PlatformEinvoiceRecord.name, schema: PlatformEinvoiceSchema },
      { name: StoreEinvoiceRecord.name, schema: StoreEinvoiceSchema },
      // Read-only: the shadow ledger (eligible rows become invoices) ...
      { name: PlatformInvoice.name, schema: PlatformInvoiceSchema },
      // ... and a wholesale order's company (its tax ID) for the buyer on the invoice.
      { name: B2BCompany.name, schema: B2BCompanySchema },
    ]),
  ],
  controllers: [AdminFbrDiController, StoreFbrDiController],
  providers: [
    FbrDiService, FbrDiClient, PlatformEinvoiceService, StoreEinvoiceService,
    { provide: TaxAuthorityRegistry, useFactory: (client: FbrDiClient) => new TaxAuthorityRegistry().register(new PkFbrAdapter(client)), inject: [FbrDiClient] },
  ],
  exports: [FbrDiService, PlatformEinvoiceService, StoreEinvoiceService, TaxAuthorityRegistry],
})
export class FbrDiModule {}
