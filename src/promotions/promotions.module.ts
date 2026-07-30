import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { MediaLibraryModule } from '../media-library/media-library.module';
import { EmailService } from '../otp/services/email.service';
import { PromotionsController } from './promotions.controller';
import { AdminPromotionsController } from './admin-promotions.controller';
import { PublicPromotionsController } from './public-promotions.controller';
import { PromotionsService } from './promotions.service';
import { PromotionPricingService } from './promotion-pricing.service';

@Module({
  imports: [AuthModule, RedisModule, AdminConfigModule, MediaLibraryModule],
  controllers: [PromotionsController, AdminPromotionsController, PublicPromotionsController],
  providers: [PromotionsService, PromotionPricingService, EmailService],
  exports: [PromotionsService],
})
export class PromotionsModule {}
