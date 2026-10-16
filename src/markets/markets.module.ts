import { Module } from '@nestjs/common';
import { MarketsController } from './markets.controller';
import { MarketsService } from './markets.service';
import { MarketPricingController } from './market-pricing.controller';
import { MarketPricingService } from './market-pricing.service';
import { MarketDomainController } from './market-domain.controller';
import { MarketDomainService } from './market-domain.service';
import { PublicMarketsController } from './public-markets.controller';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';
import { DatabaseModule } from '@/database/database.module';
import { AdminConfigModule } from '@/admin-config/admin-config.module';
import { ExchangeRateModule } from '@/exchange-rate/exchange-rate.module';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    DatabaseModule,
    AdminConfigModule,
    ExchangeRateModule,
  ],
  controllers: [MarketsController, MarketPricingController, MarketDomainController, PublicMarketsController],
  providers: [MarketsService, MarketPricingService, MarketDomainService],
  exports: [MarketsService, MarketPricingService, MarketDomainService],
})
export class MarketsModule {}
