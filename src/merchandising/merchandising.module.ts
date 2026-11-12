/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { MerchandisingController, PublicMerchandisingController } from './merchandising.controller';
import { MerchandisingService } from './merchandising.service';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [MerchandisingController, PublicMerchandisingController],
  providers: [MerchandisingService],
  exports: [MerchandisingService],
})
export class MerchandisingModule {}
