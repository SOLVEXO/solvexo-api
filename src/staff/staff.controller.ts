/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { StaffService } from './staff.service';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { AcceptStaffInviteDto } from './dto/accept-staff-invite.dto';
import { ChangeOwnStaffPasswordDto, StaffForgotPasswordDto, StaffResetPasswordDto, UpdateOwnStaffProfileDto } from './dto/staff-account.dto';

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

  // Public — forgot/reset password. Literal segments, declared before the
  // dynamic `:storeId` routes below.
  @Post('reset-password/:token')
  async resetPassword(@Param('token') token: string, @Body() dto: StaffResetPasswordDto) {
    return this.staffService.resetPassword(token, dto.password);
  }

  @Post(':storeId/forgot-password')
  async forgotPassword(@Param('storeId') storeId: string, @Body() dto: StaffForgotPasswordDto) {
    return this.staffService.forgotPassword(storeId, dto.email);
  }

  // The signed-in staff member's OWN account (no staff.manage needed).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('staff')
  @Patch('me')
  async updateMe(@Req() req: any, @Body() dto: UpdateOwnStaffProfileDto) {
    return this.staffService.updateOwnProfile(req.user.userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('staff')
  @Put('me/password')
  async changeMyPassword(@Req() req: any, @Body() dto: ChangeOwnStaffPasswordDto) {
    const token = req.headers.authorization?.split(' ')[1];
    return this.staffService.changeOwnPassword(req.user.userId, dto.currentPassword, dto.newPassword, token);
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
  @Delete(':storeId/:staffId')
  async remove(@Req() req: any, @Param('storeId') storeId: string, @Param('staffId') staffId: string) {
    const { userId, role, permissions } = req.user;
    return this.staffService.remove(userId, role, permissions, storeId, staffId);
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
