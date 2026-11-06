import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { CodProtectionSettings, CodProtectionSettingsSchema } from './cod-protection.schema';
import { CodProtectionService } from './cod-protection.service';
import { CodProtectionController } from './cod-protection.controller';
import { CodConfirmationService } from './cod-confirmation.service';
import { PublicCodController } from './public-cod.controller';

@Module({
  imports: [AuthModule, RedisModule, ExchangeRateModule, MongooseModule.forFeature([{ name: CodProtectionSettings.name, schema: CodProtectionSettingsSchema }])],
  controllers: [CodProtectionController, PublicCodController],
  providers: [CodProtectionService, CodConfirmationService],
  exports: [CodProtectionService, CodConfirmationService],
})
export class CodProtectionModule {}
