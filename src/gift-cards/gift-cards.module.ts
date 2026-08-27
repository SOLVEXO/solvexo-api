import { Module } from '@nestjs/common';
import { GiftCardsController } from './gift-cards.controller';
import { GiftCardsService } from './gift-cards.service';
import { AuthModule } from '../auth/auth.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { EmailService } from '../otp/services/email.service';

@Module({
  imports: [AuthModule, ExchangeRateModule],
  controllers: [GiftCardsController],
  providers: [GiftCardsService, EmailService],
  exports: [GiftCardsService],
})
export class GiftCardsModule {}
