/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AbandonedCartController } from './abandoned-cart.controller';
import { AbandonedCartService } from './abandoned-cart.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { EmailService } from '../otp/services/email.service';

// RedisModule alongside AuthModule — required by every module whose
// controller uses JwtAuthGuard (see GiftCardsModule's own doc comment for
// the exact failure this avoids).
@Module({
  imports: [AuthModule, RedisModule],
  controllers: [AbandonedCartController],
  providers: [AbandonedCartService, EmailService],
  exports: [AbandonedCartService],
})
export class AbandonedCartModule {}
