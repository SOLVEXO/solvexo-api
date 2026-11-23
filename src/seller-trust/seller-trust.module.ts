import { Module } from '@nestjs/common';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { SellerTrustService } from './seller-trust.service';
import { SellerTrustReminderService } from './seller-trust-reminder.service';

// Deliberately tiny (DatabaseModule is global; only AdminConfig for the
// enforcement settings) so StoreModule, FinanceModule, the admin modules and
// the scheduler can all import it without creating a module cycle.
@Module({
  imports: [AdminConfigModule],
  providers: [SellerTrustService, SellerTrustReminderService],
  exports: [SellerTrustService, SellerTrustReminderService],
})
export class SellerTrustModule {}
