import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { LicenseKey, LicenseKeySchema } from './license.schema';
import { PlatformPlansModule } from '../platform-plans/platform-plans.module';
import { LicensesService } from './licenses.service';
import { DigitalMailerModule } from '../digital-access/digital-mailer.module';
import { BuyerLicensesController, LicenseApiController, SellerLicensesController } from './licenses.controller';

@Module({
  imports: [AuthModule, RedisModule, PlatformPlansModule, DigitalMailerModule, MongooseModule.forFeature([{ name: LicenseKey.name, schema: LicenseKeySchema }])],
  controllers: [LicenseApiController, BuyerLicensesController, SellerLicensesController],
  providers: [LicensesService],
  exports: [LicensesService],
})
export class LicensesModule {}
