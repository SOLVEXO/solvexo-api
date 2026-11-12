/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { SeoModule } from '../seo/seo.module';
import { SiteAnalyticsSettings, SiteAnalyticsSettingsSchema } from './schemas/site-analytics-settings.schema';
import { SiteAnalyticsService } from './site-analytics.service';
import { StoreJourneyService } from './store-journey.service';
import { SiteAnalyticsAdminController, SiteAnalyticsPublicController } from './site-analytics.controller';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    SeoModule,
    MongooseModule.forFeature([{ name: SiteAnalyticsSettings.name, schema: SiteAnalyticsSettingsSchema }]),
  ],
  controllers: [SiteAnalyticsAdminController, SiteAnalyticsPublicController],
  providers: [SiteAnalyticsService, StoreJourneyService],
})
export class SiteAnalyticsModule {}
