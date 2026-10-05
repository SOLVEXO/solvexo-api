/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { CustomerSocialLoginService } from './customer-social-login.service';
import { BuyerSocialLoginController, SellerCustomerSocialLoginController } from './customer-social-login.controller';

// AuthModule supplies AuthService + GuestSessionService + the guards; RedisModule the one-time exchange codes.
@Module({
  imports: [AuthModule, RedisModule],
  controllers: [SellerCustomerSocialLoginController, BuyerSocialLoginController],
  providers: [CustomerSocialLoginService],
})
export class CustomerSocialLoginModule {}
