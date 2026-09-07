import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ShippingZonesController } from './shipping-zones.controller';
import { ShippingZonesService } from './shipping-zones.service';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [ShippingZonesController],
  providers: [ShippingZonesService],
  exports: [ShippingZonesService],
})
export class ShippingZonesModule {}
