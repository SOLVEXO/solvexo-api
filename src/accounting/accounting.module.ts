import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { PosModule } from '../pos/pos.module';
import { KhataAccount, KhataAccountSchema, KhataEntry, KhataEntrySchema } from '../khata/khata.schema';
import { AccountingSettings, AccountingSettingsSchema, GatewaySettlement, GatewaySettlementSchema, JournalEntry, JournalEntrySchema, LedgerAccount, LedgerAccountSchema } from './accounting.schema';
import { AccountingStatementsService } from './accounting-statements.service';
import { AccountingSettlementsService } from './accounting-settlements.service';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { AccountingSyncService } from './accounting-sync.service';
import { AccountingBooksService } from './accounting-books.service';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    PosModule,
    MongooseModule.forFeature([
      { name: LedgerAccount.name, schema: LedgerAccountSchema },
      { name: AccountingSettings.name, schema: AccountingSettingsSchema },
      { name: JournalEntry.name, schema: JournalEntrySchema },
      { name: GatewaySettlement.name, schema: GatewaySettlementSchema },
      { name: KhataEntry.name, schema: KhataEntrySchema },
      { name: KhataAccount.name, schema: KhataAccountSchema },
    ]),
  ],
  controllers: [AccountingController],
  providers: [AccountingService, AccountingSyncService, AccountingBooksService, AccountingStatementsService, AccountingSettlementsService],
  exports: [AccountingService],
})
export class AccountingModule {}
