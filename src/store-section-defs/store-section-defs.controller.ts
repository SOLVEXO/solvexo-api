import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { StoreSectionDefsService } from './store-section-defs.service';

/** The layout tree is checked element by element in `deriveStoreSectionDef`; this only guards the envelope. */
export class CreateStoreSectionDefDto {
  @IsString() @MaxLength(60) name: string;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
  @IsOptional() @IsString() @MaxLength(7) color?: string | null;
  @IsObject() layout: Record<string, any>;
}

export class UpdateStoreSectionDefDto {
  @IsOptional() @IsString() @MaxLength(60) name?: string;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
  @IsOptional() @IsString() @MaxLength(7) color?: string | null;
  @IsOptional() @IsObject() layout?: Record<string, any>;
}

/** The "Section builder": the seller's own section designs, edited in the theme editor area. */
@ApiTags('Section builder')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('onlinestore.themes.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/store-section-defs')
export class StoreSectionDefsController {
  constructor(private readonly service: StoreSectionDefsService) {}

  @Get(':storeId')
  async list(@Req() req: any, @Param('storeId') storeId: string) {
    await this.service.assertStoreAccess(storeId, actingSellerId(req.user));
    return this.service.list(storeId);
  }

  @Post(':storeId')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateStoreSectionDefDto) {
    await this.service.assertStoreAccess(storeId, actingSellerId(req.user));
    return this.service.create(storeId, dto);
  }

  @Patch(':storeId/:id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdateStoreSectionDefDto) {
    await this.service.assertStoreAccess(storeId, actingSellerId(req.user));
    return this.service.update(storeId, id, dto);
  }

  @Delete(':storeId/:id')
  async remove(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    await this.service.assertStoreAccess(storeId, actingSellerId(req.user));
    return this.service.remove(storeId, id);
  }
}
