import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { CustomDomainsController } from './custom-domains.controller';
import { CustomDomainsService } from './custom-domains.service';
import { StoreTaxRegionsImportController } from './store-tax-regions-import.controller';
import { VercelDomainsService } from './vercel-domains.service';
import { DomainDnsGuideService } from './domain-dns-guide.service';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';
import { AdminConfigModule } from '@/admin-config/admin-config.module';
import { MarketingModule } from '@/marketing/marketing.module';
import { UploadModule } from '@/upload/upload.module';
import { StoreThemeModule } from '../store-theme/store-theme.module';
import { StorePagesModule } from '../store-pages/store-pages.module';
import { CollectionsModule } from '../collections/collections.module';

import { StorefrontAccessService } from './storefront-access.service';

@Module({
  imports: [AuthModule, RedisModule, AdminConfigModule, MarketingModule, UploadModule, StoreThemeModule, StorePagesModule, CollectionsModule],
  controllers: [StoreController, CustomDomainsController, StoreTaxRegionsImportController],
  providers: [StoreService, StorefrontAccessService, CustomDomainsService, VercelDomainsService, DomainDnsGuideService],
  exports: [StoreService, StorefrontAccessService, CustomDomainsService],
})
export class StoreModule {}
