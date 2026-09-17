import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ShippingCarrier, ShippingCarrierSchema } from './schemas/shipping-carrier.schema';
import { ShippingCarriersController } from './shipping-carriers.controller';
import { ShippingCarriersService } from './shipping-carriers.service';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    MongooseModule.forFeature([{ name: ShippingCarrier.name, schema: ShippingCarrierSchema }]),
  ],
  controllers: [ShippingCarriersController],
  providers: [ShippingCarriersService],
})
export class ShippingCarriersModule {}
