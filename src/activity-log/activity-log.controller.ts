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
import { actingSellerId } from '../common/acting-seller-id.util';
@ApiTags('Activity Log')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/activity-log')
export class ActivityLogController {
  constructor(private readonly activityLogService: ActivityLogService) {}

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('activity_log.view')
  @Get(':storeId')
  getAll(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.activityLogService.findAll(actingSellerId(req.user), storeId, query);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('activity_log.view')
  @Get(':storeId/stats')
  getStats(@Req() req: any, @Param('storeId') storeId: string) {
    return this.activityLogService.getStats(actingSellerId(req.user), storeId);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('activity_log.view')
  @Get(':storeId/timeline/:targetId')
  getTimeline(@Req() req: any, @Param('storeId') storeId: string, @Param('targetId') targetId: string) {
    return this.activityLogService.getTimelineForSeller(actingSellerId(req.user), storeId, targetId);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('activity_log.view')
  @Get(':storeId/export')
  async export(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any, @Res() res: Response) {
    const { csv, count, truncated } = await this.activityLogService.exportCsv(actingSellerId(req.user), storeId, query);
    // Exporting the audit trail is itself an auditable act (who took a copy of the store's history).
    void this.activityLogService.log({
      storeId, category: 'security', action: 'activity_log_exported',
      description: `Activity log exported (${count} event${count === 1 ? '' : 's'}${truncated ? ', limited to the most recent' : ''})`,
      actorId: String(req.user.userId ?? req.user.sub ?? req.user.id ?? ''), actorRole: req.user.role, ip: req.ip,
      userAgent: req.headers?.['user-agent'] ?? null,
    });
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', `attachment; filename="activity-log-${storeId}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.header('Access-Control-Expose-Headers', 'X-Export-Truncated, X-Export-Count');
    res.header('X-Export-Count', String(count));
    res.header('X-Export-Truncated', truncated ? 'true' : 'false');
    res.send(csv);
  }
}
