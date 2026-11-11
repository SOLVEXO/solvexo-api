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
import { PlatformPlanInvoice, PlatformPlanInvoiceSchema } from '../platform-plans/schemas/platform-plan-invoice.schema';
import { PlatformAddonPurchase, PlatformAddonPurchaseSchema } from '../platform-plans/schemas/platform-addon-purchase.schema';
import { TransactionFeeBill, TransactionFeeBillSchema } from '../platform-plans/schemas/transaction-fee-bill.schema';
import { PlatformLegalEntity, PlatformLegalEntitySchema } from './schemas/platform-legal-entity.schema';
import { PlatformTaxRegistration, PlatformTaxRegistrationSchema } from './schemas/platform-tax-registration.schema';
import { PlatformTaxRule, PlatformTaxRuleSchema } from './schemas/platform-tax-rule.schema';
import { PlatformInvoice, PlatformInvoiceSchema } from './schemas/platform-invoice.schema';
import { PlatformEntityService } from './platform-entity.service';
import { PlatformTaxDeterminationService } from './platform-tax-determination.service';
import { PlatformLedgerService } from './platform-ledger.service';
import { PlatformLedgerController } from './platform-ledger.controller';
import { PlatformTaxCompliance, PlatformTaxComplianceSchema } from './schemas/platform-tax-compliance.schema';
import { PlatformComplianceService } from './platform-compliance.service';
import { PlatformComplianceController } from './platform-compliance.controller';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PlatformTaxSettings.name, schema: PlatformTaxSettingsSchema },
      { name: PlatformTaxRecord.name, schema: PlatformTaxRecordSchema },
      // Phase 1 shadow ledger: the first three are only READ here (registered a second time for injection), the last four are its own.
      { name: PlatformPlanInvoice.name, schema: PlatformPlanInvoiceSchema },
      { name: PlatformAddonPurchase.name, schema: PlatformAddonPurchaseSchema },
      { name: TransactionFeeBill.name, schema: TransactionFeeBillSchema },
      { name: PlatformLegalEntity.name, schema: PlatformLegalEntitySchema },
      { name: PlatformTaxRegistration.name, schema: PlatformTaxRegistrationSchema },
      { name: PlatformTaxRule.name, schema: PlatformTaxRuleSchema },
      { name: PlatformInvoice.name, schema: PlatformInvoiceSchema },
      { name: PlatformTaxCompliance.name, schema: PlatformTaxComplianceSchema },
    ]),
    // RedisModule: JwtAuthGuard injects RedisService, which only resolves when this module imports it (AuthModule
    // doesn't re-export it). Without it every admin tax route returned 500 "reading 'isConnected'".
    AuthModule, RedisModule, SubscriptionsModule, ExchangeRateModule,
  ],
  controllers: [PlatformTaxController, PlatformTaxQuoteController, PlatformLedgerController, PlatformComplianceController],
  providers: [PlatformTaxService, PlatformEntityService, PlatformTaxDeterminationService, PlatformLedgerService, PlatformComplianceService],
  exports: [PlatformTaxService, PlatformLedgerService, PlatformEntityService, PlatformComplianceService],
})
export class PlatformTaxModule {}
