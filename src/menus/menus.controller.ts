/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { MenusService } from './menus.service';
import { CreateMenuDto, UpdateMenuDto } from './dto/menu-item.dto';

@ApiTags('Menus')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('content.menus.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/menus')
export class MenusController {
  constructor(private readonly menusService: MenusService) {}

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.menusService.list(storeId, actingSellerId(req.user));
  }

  @Post(':storeId')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateMenuDto) {
    return this.menusService.create(storeId, actingSellerId(req.user), dto);
  }

  @Patch(':storeId/:menuId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('menuId') menuId: string, @Body() dto: UpdateMenuDto) {
    return this.menusService.update(storeId, actingSellerId(req.user), menuId, dto);
  }

  @Delete(':storeId/:menuId')
  delete(@Req() req: any, @Param('storeId') storeId: string, @Param('menuId') menuId: string) {
    return this.menusService.delete(storeId, actingSellerId(req.user), menuId);
  }
}
