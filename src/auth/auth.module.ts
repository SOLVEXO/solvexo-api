/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { OtpModule } from '@/otp/otp.module';
import { AdminSecurityService } from './admin-security.service';

import { User, UserSchema } from '../users/schemas/user.schema';
import { RedisModule } from '@/redis/redis.module';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { GuestSessionService } from './guest-session.service';
import { AuthVisualService } from '../common/auth-visual.service';
import { AdminAuthVisualController } from './admin-auth-visual.controller';
import { AdminTwoFactorService } from './admin-two-factor.service';
import { MemberTwoFactorService } from './member-two-factor.service';
import { MemberTwoFactorController, SellerTwoFactorLoginController } from './member-two-factor.controller';
import { MemberTwoFactor, MemberTwoFactorSchema } from './member-two-factor.schema';
import { AppleTokenService, AppleAuthClient, FetchAppleAuthClient } from './apple-token.service';
import { AdminTwoFactorController, AdminTwoFactorLoginController } from './admin-two-factor.controller';

@Module({
  imports: [
   
    ConfigModule,
     OtpModule,
    RedisModule,
    PassportModule,

  
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '7d' },
      }),
    }),


    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }, { name: MemberTwoFactor.name, schema: MemberTwoFactorSchema }]),
  ],
  controllers: [AuthController, AdminAuthVisualController, AdminTwoFactorLoginController, AdminTwoFactorController, SellerTwoFactorLoginController, MemberTwoFactorController],
  providers: [AuthService, AppleTokenService, { provide: AppleAuthClient, useClass: FetchAppleAuthClient }, GuestSessionService, JwtStrategy, JwtAuthGuard, PermissionsGuard, AuthVisualService, AdminSecurityService, AdminTwoFactorService, MemberTwoFactorService],
  exports: [JwtModule, AuthService, AppleTokenService, AuthVisualService, GuestSessionService, JwtAuthGuard, PermissionsGuard, AdminSecurityService, AdminTwoFactorService, MemberTwoFactorService],
})
export class AuthModule {}
