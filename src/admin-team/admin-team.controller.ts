import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { AdminSelf } from '../auth/decorators/admin-guards.decorator';
import { AdminTeamService, Actor } from './admin-team.service';

class CreateRoleDto {
  @IsString() @MinLength(2) @MaxLength(60) name: string;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
  @IsArray() @IsString({ each: true }) permissions: string[];
  @IsOptional() @IsBoolean() readOnly?: boolean;
}
class UpdateRoleDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) permissions?: string[];
  @IsOptional() @IsBoolean() readOnly?: boolean;
}
class InviteAdminDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsEmail() email: string;
  @IsString() roleId: string;
  @IsOptional() @IsString() accessExpiresAt?: string | null;
}
class UpdateAdminDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsString() roleId?: string;
  @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
  @IsOptional() accessExpiresAt?: string | null;
}
class SuperDto { @IsBoolean() isSuperAdmin: boolean; }
class DecisionDto { @IsBoolean() approve: boolean; @IsOptional() @IsString() @MaxLength(300) note?: string; }
class AcceptDto { @IsString() @MinLength(8) @MaxLength(128) password: string; }
class ForgotDto { @IsEmail() email: string; }

const actor = (req: any): Actor => ({ userId: req.user.userId, teamAdmin: req.user.teamAdmin === true, permissions: req.user.permissions ?? [], name: req.user.email });

/** Public: accepting an invite and the forgot/reset password flow (no session yet). */
@Controller('api/admin/team')
export class AdminTeamPublicController {
  constructor(private readonly team: AdminTeamService) {}

  @Get('invite/:token')
  getInvite(@Param('token') token: string) { return this.team.getInvite(token); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('invite/:token/accept')
  accept(@Param('token') token: string, @Body() dto: AcceptDto) { return this.team.acceptInvite(token, dto.password); }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  forgot(@Body() dto: ForgotDto) { return this.team.forgotPassword(dto.email); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reset-password/:token')
  reset(@Param('token') token: string, @Body() dto: AcceptDto) { return this.team.resetPassword(token, dto.password); }
}

@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@Controller('api/admin/team')
export class AdminTeamController {
  constructor(private readonly team: AdminTeamService) {}

  // ── own account (any admin) ──
  @AdminSelf()
  @Get('me/sessions')
  mySessions(@Req() req: any) { return this.team.mySessions(req.user.userId, req.user.sid ?? null); }

  @AdminSelf()
  @Post('me/sessions/revoke-all')
  revokeAll(@Req() req: any) { return this.team.revokeAllMine(req.user.userId); }

  @AdminSelf()
  @Delete('me/sessions/:sid')
  revokeOne(@Req() req: any, @Param('sid') sid: string) { return this.team.revokeMySession(req.user.userId, sid); }

  // ── team management ──
  @RequirePermission('team.manage')
  @Get('admins')
  admins() { return this.team.listAdmins(); }

  @RequirePermission('team.manage')
  @Post('admins')
  invite(@Req() req: any, @Body() dto: InviteAdminDto) { return this.team.invite(actor(req), dto); }

  @RequirePermission('team.manage')
  @Patch('admins/:id')
  update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateAdminDto) { return this.team.update(actor(req), id, dto); }

  @RequirePermission('team.manage')
  @Post('admins/:id/resend-invite')
  resend(@Req() req: any, @Param('id') id: string) { return this.team.resendInvite(actor(req), id); }

  @RequirePermission('team.manage')
  @Post('admins/:id/revoke-sessions')
  revoke(@Req() req: any, @Param('id') id: string) { return this.team.revokeAdminSessions(actor(req), id); }

  @RequirePermission('team.manage')
  @Put('admins/:id/super')
  setSuper(@Req() req: any, @Param('id') id: string, @Body() dto: SuperDto) { return this.team.setSuper(actor(req), id, dto.isSuperAdmin); }

  @RequirePermission('team.manage')
  @Delete('admins/:id')
  remove(@Req() req: any, @Param('id') id: string) { return this.team.remove(actor(req), id); }

  @RequirePermission('team.manage')
  @Get('roles')
  roles() { return this.team.listRoles(); }

  @RequirePermission('team.manage')
  @Post('roles')
  createRole(@Req() req: any, @Body() dto: CreateRoleDto) { return this.team.createRole(actor(req), dto); }

  @RequirePermission('team.manage')
  @Patch('roles/:id')
  updateRole(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateRoleDto) { return this.team.updateRole(actor(req), id, dto); }

  @RequirePermission('team.manage')
  @Delete('roles/:id')
  removeRole(@Req() req: any, @Param('id') id: string) { return this.team.removeRole(actor(req), id); }

  @RequirePermission('team.manage')
  @Get('approvals')
  approvals(@Query('status') status?: string) { return this.team.listApprovals(status); }

  @RequirePermission('team.manage')
  @Post('approvals/:id/decision')
  decide(@Req() req: any, @Param('id') id: string, @Body() dto: DecisionDto) { return this.team.decide(actor(req), id, dto.approve, dto.note); }

  // ── audit trail ──
  @RequirePermission('audit.view')
  @Get('audit')
  audit(@Query() query: any) { return this.team.audit(query); }

  // ── view a store as an admin (read-only) ──
  @RequirePermission('clients.view')
  @Post('view-as-store/:storeId')
  viewAs(@Req() req: any, @Param('storeId') storeId: string) { return this.team.viewAsStore(actor(req), storeId); }
}
