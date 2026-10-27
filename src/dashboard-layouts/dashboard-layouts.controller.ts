import { Body, Controller, Delete, Get, Param, Put, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { AdminSelf } from '../auth/decorators/admin-guards.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { DashboardLayoutsService } from './dashboard-layouts.service';
import { MAX_WIDGETS } from './dashboard-widgets.const';

/** The widgets themselves are checked field by field in `validateLayout`; this only guards the envelope. */
export class SaveDashboardLayoutDto {
  @IsArray() @ArrayMaxSize(MAX_WIDGETS) widgets: unknown[];
  @IsOptional() @IsIn([2, 3]) columns?: number;
  @IsOptional() @IsString() @MaxLength(30) preset?: string;
}

/** Store Dashboard layout of the CALLING user (seller or staff) for one store. */
@ApiTags('Dashboard layouts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('home.view')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/dashboard-layouts/store')
export class StoreDashboardLayoutsController {
  constructor(private readonly service: DashboardLayoutsService) {}

  @Get(':storeId')
  async get(@Req() req: any, @Param('storeId') storeId: string) {
    await this.service.assertStoreAccess(storeId, actingSellerId(req.user));
    return this.service.get('store', req.user.userId, storeId);
  }

  @Put(':storeId')
  async save(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: SaveDashboardLayoutDto) {
    await this.service.assertStoreAccess(storeId, actingSellerId(req.user));
    return this.service.save('store', req.user.userId, storeId, dto);
  }

  @Delete(':storeId')
  async reset(@Req() req: any, @Param('storeId') storeId: string) {
    await this.service.assertStoreAccess(storeId, actingSellerId(req.user));
    return this.service.reset('store', req.user.userId, storeId);
  }
}

/** Super Admin Home layout of the CALLING admin. It only changes what is arranged on screen: every widget still loads
 *  through its own permission-guarded admin endpoint. */
@ApiTags('Dashboard layouts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/dashboard-layouts/admin')
export class AdminDashboardLayoutsController {
  constructor(private readonly service: DashboardLayoutsService) {}

  @AdminSelf()
  @Get()
  get(@Req() req: any) {
    return this.service.get('admin', req.user.userId);
  }

  @AdminSelf()
  @Put()
  save(@Req() req: any, @Body() dto: SaveDashboardLayoutDto) {
    return this.service.save('admin', req.user.userId, '', dto);
  }

  @AdminSelf()
  @Delete()
  reset(@Req() req: any) {
    return this.service.reset('admin', req.user.userId);
  }
}
