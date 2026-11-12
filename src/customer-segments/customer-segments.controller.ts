/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { CustomerSegmentsService } from './customer-segments.service';

/** Saved customer segments. Reads: customers.view · writes: customers.edit · CSV: customers.export. Store-pinned for staff. */
@ApiTags('Customer Segments')
@ApiBearerAuth('accessToken')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@Controller('api/customer-segments/:storeId')
export class CustomerSegmentsController {
  constructor(private readonly service: CustomerSegmentsService) {}

  @Get()
  @RequirePermission('customers.view')
  list(@Req() req: any, @Param('storeId') storeId: string) { return this.service.list(storeId, actingSellerId(req.user)); }

  // static segments of the path first — they must not be swallowed by `:segmentId`
  @Post('preview')
  @RequirePermission('customers.view')
  preview(@Req() req: any, @Param('storeId') storeId: string, @Body() body: any) {
    return this.service.preview(storeId, actingSellerId(req.user), body?.filter);
  }

  @Post()
  @RequirePermission('customers.edit')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() body: any) {
    return this.service.create(storeId, actingSellerId(req.user), body ?? {});
  }

  @Get(':segmentId')
  @RequirePermission('customers.view')
  get(@Req() req: any, @Param('storeId') storeId: string, @Param('segmentId') id: string) { return this.service.get(storeId, actingSellerId(req.user), id); }

  @Get(':segmentId/count')
  @RequirePermission('customers.view')
  count(@Req() req: any, @Param('storeId') storeId: string, @Param('segmentId') id: string) { return this.service.count(storeId, actingSellerId(req.user), id); }

  @Get(':segmentId/members')
  @RequirePermission('customers.view')
  members(@Req() req: any, @Param('storeId') storeId: string, @Param('segmentId') id: string, @Query() query: any) {
    return this.service.members(storeId, actingSellerId(req.user), id, query ?? {});
  }

  @Get(':segmentId/export')
  @RequirePermission('customers.export')
  async export(@Req() req: any, @Param('storeId') storeId: string, @Param('segmentId') id: string, @Res() res: Response) {
    const { filename, csv } = await this.service.exportCsv(storeId, actingSellerId(req.user), id);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
    res.send(csv);
  }

  @Post(':segmentId/duplicate')
  @RequirePermission('customers.edit')
  duplicate(@Req() req: any, @Param('storeId') storeId: string, @Param('segmentId') id: string) { return this.service.duplicate(storeId, actingSellerId(req.user), id); }

  @Patch(':segmentId')
  @RequirePermission('customers.edit')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('segmentId') id: string, @Body() body: any) {
    return this.service.update(storeId, actingSellerId(req.user), id, body ?? {});
  }

  @Delete(':segmentId')
  @RequirePermission('customers.edit')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('segmentId') id: string) { return this.service.remove(storeId, actingSellerId(req.user), id); }
}
