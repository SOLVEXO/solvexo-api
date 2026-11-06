import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { ProductFeedConfig, ProductFeedConfigSchema } from './feed.schema';
import { ProductFeedsController, PublicProductFeedsController } from './product-feeds.controller';
import { ProductFeedsService } from './product-feeds.service';

@Module({
  imports: [AuthModule, RedisModule, ExchangeRateModule, MongooseModule.forFeature([{ name: ProductFeedConfig.name, schema: ProductFeedConfigSchema }])],
  controllers: [ProductFeedsController, PublicProductFeedsController],
  providers: [ProductFeedsService],
})
export class ProductFeedsModule {}
