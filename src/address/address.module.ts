import { Module } from '@nestjs/common';
import { AddressController } from './address.controller';
import { AddressService } from './address.service';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [AddressController],
  providers: [AddressService],
  exports: [AddressService],
})
export class AddressModule {}
