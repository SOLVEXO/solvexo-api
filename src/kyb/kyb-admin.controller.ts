/* eslint-disable prettier/prettier */
import {
  Body, Controller, Get, Param, Post, Put, Query, Req, Res, UseGuards, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { KybAdminService } from './kyb-admin.service';
import { KybMaintenanceService } from './kyb-maintenance.service';

export class KybListQueryDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() businessType?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsString() sort?: any;
}
export class ApproveKybDto { @IsOptional() @IsString() @MaxLength(300) note?: string; }
export class RejectKybDto { @IsString() @MaxLength(500) reason: string; }
export class SubMerchantDto { @IsString() @MaxLength(40) providerKey: string; @IsString() @MaxLength(100) ref: string; }
export class AuditQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsString() action?: string;
}
export class RetentionSettingsDto {
  @IsOptional() @Type(() => Number) afterClosureDays?: number | null;
  @IsOptional() @IsBoolean() purgeEnabled?: boolean;
}
export class RetentionRunDto { @IsOptional() @IsBoolean() dryRun?: boolean; }

/** Admin review of business verifications. Protected by the existing admin stack: JWT + role `admin` + team permission `kyb.review` / `kyb.settings`. */
@ApiTags('Admin KYB')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/kyb')
export class KybAdminController {
  constructor(private readonly admin: KybAdminService, private readonly maintenance: KybMaintenanceService) {}
  private actor(req: any) { return { type: 'admin' as const, id: req.user.userId as string, ip: req.ip as string, userAgent: req.headers?.['user-agent'] as string }; }
  private ok = async (p: Promise<any>) => ({ success: true, data: await p });

  @RequirePermission('kyb.review') @Get('submissions') list(@Query() q: KybListQueryDto) { return this.ok(this.admin.list(q)); }

  @RequirePermission('kyb.review') @Get('submissions/:storeId') detail(@Req() req: any, @Param('storeId') storeId: string) { return this.ok(this.admin.detail(storeId, this.actor(req))); }

  @RequirePermission('kyb.review') @Get('submissions/:storeId/documents/:docId/url')
  docUrl(@Req() req: any, @Param('storeId') storeId: string, @Param('docId') docId: string) { return this.ok(this.admin.documentUrl(storeId, docId, this.actor(req))); }

  @RequirePermission('kyb.review') @Get('submissions/:storeId/documents/:docId/download')
  async docDownload(@Req() req: any, @Res() res: Response, @Param('storeId') storeId: string, @Param('docId') docId: string) {
    const f = await this.admin.documentDownload(storeId, docId, this.actor(req));
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${f.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(f.buffer);
  }

  @RequirePermission('kyb.review') @Post('submissions/:storeId/approve') approve(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: ApproveKybDto) { return this.ok(this.admin.approve(storeId, this.actor(req), dto.note)); }

  @RequirePermission('kyb.review') @Post('submissions/:storeId/reject') reject(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: RejectKybDto) { return this.ok(this.admin.reject(storeId, this.actor(req), dto.reason)); }

  @RequirePermission('kyb.review') @Put('submissions/:storeId/sub-merchant') subMerchant(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: SubMerchantDto) { return this.ok(this.admin.setSubMerchant(storeId, this.actor(req), dto)); }

  @RequirePermission('kyb.review') @Get('submissions/:storeId/audit') audit(@Param('storeId') storeId: string, @Query() q: AuditQueryDto) { return this.ok(this.admin.auditTrail(storeId, q)); }

  @RequirePermission('kyb.settings') @Get('retention') getRetention() { return this.ok(this.maintenance.getSettings()); }

  @RequirePermission('kyb.settings') @Put('retention') putRetention(@Req() req: any, @Body() dto: RetentionSettingsDto) { return this.ok(this.maintenance.updateSettings(req.user.userId, dto, { ip: req.ip, userAgent: req.headers?.['user-agent'] })); }

  @RequirePermission('kyb.settings') @Post('retention/run') runRetention(@Req() req: any, @Body() dto: RetentionRunDto) { return this.ok(this.maintenance.runRetention({ dryRun: dto.dryRun !== false, actor: { type: 'admin', id: req.user.userId } })); }
}
