import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { StoreShippingZonesController } from './shipping-zones.controller';
import { ShippingZonesService } from './shipping-zones.service';
import { ShippingProfilesController } from './shipping-profiles.controller';
import { ShippingProfilesService } from './shipping-profiles.service';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [StoreShippingZonesController, ShippingProfilesController],
  providers: [ShippingZonesService, ShippingProfilesService],
  exports: [ShippingZonesService, ShippingProfilesService],
})
export class ShippingZonesModule {}
