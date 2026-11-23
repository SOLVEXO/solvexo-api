/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ActivityLogService } from './activity-log.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
/**
 * Platform-wide (unscoped by storeId — pass `storeId` as a query filter to
 * narrow) audit trail viewer for admins. Every module in this codebase
 * writes to the same `ActivityLogService.log()` — this is just the first
 * admin-facing read surface over it, so an admin can actually answer "who
 * approved this payout" / "who changed the commission rate" without direct
 * DB access. Backend API only — no admin app UI exists to consume this yet.
 */
@ApiTags('Admin Activity Log')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@Controller('api/admin/activity-log')
export class AdminActivityLogController {
  constructor(private readonly activityLogService: ActivityLogService) {}

  @RequirePermission('activity.view')
  @Get()
  getAll(@Query() query: any) {
    return this.activityLogService.adminFindAll(query);
  }

  @RequirePermission('activity.view')
  @Get('stats')
  getStats() {
    return this.activityLogService.adminGetStats();
  }

  // Static path above must stay registered before this dynamic one.
  @RequirePermission('activity.view')
  @Get('timeline/:targetId')
  getTimeline(@Param('targetId') targetId: string) {
    return this.activityLogService.getTimeline(targetId);
  }

  @RequirePermission('activity.view')
  @Get('export')
  async export(@Req() req: any, @Query() query: any, @Res() res: Response) {
    const { csv, count, truncated } = await this.activityLogService.adminExportCsv(query);
    void this.activityLogService.log({
      category: 'admin_audit', action: 'activity_log_exported',
      description: `Platform activity log exported (${count} event${count === 1 ? '' : 's'}${truncated ? ', limited to the most recent' : ''})`,
      actorId: String(req.user?.userId ?? req.user?.sub ?? req.user?.id ?? ''), actorRole: req.user?.role, ip: req.ip,
      userAgent: req.headers?.['user-agent'] ?? null, isSecurityAlert: false,
    });
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', `attachment; filename="admin-activity-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.header('Access-Control-Expose-Headers', 'X-Export-Truncated, X-Export-Count');
    res.header('X-Export-Count', String(count));
    res.header('X-Export-Truncated', truncated ? 'true' : 'false');
    res.send(csv);
  }
}
