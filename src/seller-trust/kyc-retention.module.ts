import { Module } from '@nestjs/common';
import { UploadModule } from '../upload/upload.module';
import { SellerTrustModule } from './seller-trust.module';
import { KycRetentionService } from './kyc-retention.service';

// Separate from SellerTrustModule on purpose: that one is kept tiny (no UploadModule/AuthModule) because StoreModule,
// FinanceModule and the admin modules all import it. Only the scheduler imports this one.
@Module({
  imports: [UploadModule, SellerTrustModule],
  providers: [KycRetentionService],
  exports: [KycRetentionService],
})
export class KycRetentionModule {}
