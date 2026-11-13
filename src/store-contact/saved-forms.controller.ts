/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { SavedFormsService } from './saved-forms.service';

@ApiTags('Saved forms')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('onlinestore.content.manage')
@UsePipes(new ValidationPipe({ whitelist: false, transform: false }))
@Controller('api/store-contact/saved-forms')
export class SavedFormsController {
  constructor(private readonly service: SavedFormsService) {}

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.service.list(storeId, actingSellerId(req.user));
  }

  @Post(':storeId')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() body: { name?: unknown; settings?: unknown }) {
    return this.service.create(storeId, actingSellerId(req.user), body?.name, body?.settings);
  }

  @Delete(':storeId/:id')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.service.remove(storeId, actingSellerId(req.user), id);
  }
}
