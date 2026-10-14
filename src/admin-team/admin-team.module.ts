import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { EmailService } from '../otp/services/email.service';
import { AdminTeamService } from './admin-team.service';
import { AdminTeamController, AdminTeamPublicController } from './admin-team.controller';
import { AdminAuditInterceptor } from './admin-audit.interceptor';

@Module({
  imports: [AuthModule, DatabaseModule, RedisModule, ActivityLogModule],
  controllers: [AdminTeamPublicController, AdminTeamController],
  providers: [AdminTeamService, EmailService, { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor }],
  exports: [AdminTeamService],
})
export class AdminTeamModule {}
