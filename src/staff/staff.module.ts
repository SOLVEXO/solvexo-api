/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { RoleController } from './role.controller';
import { RoleService } from './role.service';
import { EmailService } from '../otp/services/email.service';

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    RedisModule,
    ActivityLogModule,
    // Same secret/signing convention as AuthModule — a staff JWT is
    // verified by the shared JwtStrategy either way, this registration is
    // only needed so StaffService can SIGN one (JwtService itself isn't
    // exported by AuthModule).
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [StaffController, RoleController],
  providers: [StaffService, RoleService, EmailService],
  exports: [StaffService, RoleService],
})
export class StaffModule {}
