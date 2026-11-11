import { Module } from '@nestjs/common';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { SellerTrustService } from './seller-trust.service';

// Deliberately tiny (DatabaseModule is global; only AdminConfig for the
// enforcement settings) so StoreModule, FinanceModule, the admin modules and
// the scheduler can all import it without creating a module cycle.
@Module({
  imports: [AdminConfigModule],
  providers: [SellerTrustService],
  exports: [SellerTrustService],
})
export class SellerTrustModule {}
