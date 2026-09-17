import { Module } from '@nestjs/common';
import { GiftCardsController } from './gift-cards.controller';
import { GiftCardsService } from './gift-cards.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { EmailService } from '../otp/services/email.service';

// `RedisModule` alongside `AuthModule` is required by every module whose
// controller uses `JwtAuthGuard` — the guard injects `RedisService` for its
// session-revocation check, and that only resolves if this module's own DI
// graph includes it (not implied by importing `AuthModule` alone). Missing
// here caused a real, reproducible `TypeError: Cannot read properties of
// undefined (reading 'isConnected')` 500 on every authenticated Gift Cards
// route — same bug class already fixed once for `MetafieldsModule`/
// `MenusModule` (see those modules' own doc comments).
@Module({
  imports: [AuthModule, RedisModule, ExchangeRateModule],
  controllers: [GiftCardsController],
  providers: [GiftCardsService, EmailService],
  exports: [GiftCardsService],
})
export class GiftCardsModule {}
