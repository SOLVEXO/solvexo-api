/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { RoleService } from './role.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

@Controller('api/staff')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'admin', 'staff')
@RequirePermission('staff.manage')
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @Get(':storeId/roles')
  async list(@Req() req: any, @Param('storeId') storeId: string) {
    const { role } = req.user;
    return this.roleService.list(actingSellerId(req.user), role, storeId);
  }

  @Post(':storeId/roles')
  async create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateRoleDto) {
    const { role } = req.user;
    return this.roleService.create(actingSellerId(req.user), role, storeId, dto);
  }

  @Patch(':storeId/roles/:roleId')
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('roleId') roleId: string, @Body() dto: UpdateRoleDto) {
    const { role } = req.user;
    return this.roleService.update(actingSellerId(req.user), role, storeId, roleId, dto);
  }

  @Delete(':storeId/roles/:roleId')
  async remove(@Req() req: any, @Param('storeId') storeId: string, @Param('roleId') roleId: string) {
    const { role } = req.user;
    return this.roleService.remove(actingSellerId(req.user), role, storeId, roleId);
  }
}
