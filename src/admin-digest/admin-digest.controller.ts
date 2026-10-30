/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Post, Put, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { AdminSelf } from '../auth/decorators/admin-guards.decorator';
import { AdminDigestService } from './admin-digest.service';

class DigestSettingsDto { @IsBoolean() weeklyDigest: boolean; }

@ApiTags('Admin Digest')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/digest')
export class AdminDigestController {
  constructor(private readonly digest: AdminDigestService) {}

  /** The admin's own weekly-digest switch. */
  @AdminSelf()
  @Get('settings')
  settings(@Req() req: any) { return this.digest.getSettings(req.user.userId); }

  @AdminSelf()
  @Put('settings')
  updateSettings(@Req() req: any, @Body() dto: DigestSettingsDto) { return this.digest.updateSettings(req.user.userId, dto.weeklyDigest); }

  /** This week's digest as it would be sent now (subject + HTML), for the in-panel preview. */
  @RequirePermission('analytics.view')
  @Get('preview')
  async preview() {
    const { subject, html } = await this.digest.build();
    return { success: true, data: { subject, html } };
  }

  /** Emails this week's digest to the calling admin only. */
  @RequirePermission('analytics.view')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('send-test')
  async sendTest(@Req() req: any) {
    const sent = await this.digest.sendDigest(String(req.user.userId));
    return { success: true, data: { sent }, message: sent ? 'Sent. Check your inbox (and the bell).' : 'Nothing sent: your account can\'t receive the digest.' };
  }
}
