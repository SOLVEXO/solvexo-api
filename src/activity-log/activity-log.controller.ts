/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ActivityLogService } from './activity-log.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@ApiTags('Activity Log')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/activity-log')
export class ActivityLogController {
  constructor(private readonly activityLogService: ActivityLogService) {}

  @Get(':storeId')
  getAll(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.activityLogService.findAll(req.user.userId, storeId, query);
  }

  @Get(':storeId/stats')
  getStats(@Req() req: any, @Param('storeId') storeId: string) {
    return this.activityLogService.getStats(req.user.userId, storeId);
  }

  @Get(':storeId/export')
  async export(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any, @Res() res: Response) {
    const csv = await this.activityLogService.exportCsv(req.user.userId, storeId, query);
    res.header('Content-Type', 'text/csv');
    res.header('Content-Disposition', `attachment; filename="activity-log-${storeId}.csv"`);
    res.send(csv);
  }
}
