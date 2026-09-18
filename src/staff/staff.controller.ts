/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { StaffService } from './staff.service';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { AcceptStaffInviteDto } from './dto/accept-staff-invite.dto';

@Controller('api/staff')
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  // Public — a staff member has no seller/buyer JWT to present yet.
  @Post(':storeId/login')
  async login(@Param('storeId') storeId: string, @Body() body: { email: string; password: string }) {
    return this.staffService.login(storeId, body.email, body.password);
  }

  @Get('permissions')
  listPermissions() {
    return this.staffService.listPermissions();
  }

  // Public — invite-acceptance routes, literal `invite/:token` segments
  // registered ahead of the dynamic `:storeId`-shaped routes below (same
  // route-ordering convention this codebase follows everywhere else),
  // though the differing segment count already makes collision impossible.
  @Get('invite/:token')
  async getInvite(@Param('token') token: string) {
    return this.staffService.getInvite(token);
  }

  @Post('invite/:token/accept')
  async acceptInvite(@Param('token') token: string, @Body() dto: AcceptStaffInviteDto) {
    return this.staffService.acceptInvite(token, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('staff.manage')
  @Post(':storeId')
  async create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateStaffDto) {
    const { userId, role, permissions } = req.user;
    return this.staffService.create(userId, role, permissions, storeId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('staff.manage')
  @Get(':storeId')
  async list(@Req() req: any, @Param('storeId') storeId: string) {
    const { userId, role } = req.user;
    return this.staffService.list(userId, role, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('staff.manage')
  @Patch(':storeId/:staffId')
  async update(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('staffId') staffId: string,
    @Body() dto: UpdateStaffDto,
  ) {
    const { userId, role, permissions } = req.user;
    return this.staffService.update(userId, role, permissions, storeId, staffId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('staff.manage')
  @Patch(':storeId/:staffId/deactivate')
  async deactivate(@Req() req: any, @Param('storeId') storeId: string, @Param('staffId') staffId: string) {
    const { userId, role, permissions } = req.user;
    return this.staffService.deactivate(userId, role, permissions, storeId, staffId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('staff.manage')
  @Post(':storeId/:staffId/resend-invite')
  async resendInvite(@Req() req: any, @Param('storeId') storeId: string, @Param('staffId') staffId: string) {
    const { userId, role, permissions } = req.user;
    return this.staffService.resendInvite(userId, role, permissions, storeId, staffId);
  }
}
