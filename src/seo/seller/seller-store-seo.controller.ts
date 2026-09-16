/* eslint-disable prettier/prettier */
import { Controller, Get, Patch, Param, Body, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { PermissionsGuard } from '@/auth/guards/permissions.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { RequirePermission } from '@/auth/decorators/require-permission.decorator';
import { DatabaseService } from '@/database/databaseservice';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { actingSellerId } from '@/common/acting-seller-id.util';
import { StoreSeoService } from '../services/store-seo.service';
import { UpdateSeoMetaDto } from '../dto/update-seo-meta.dto';
import { UpdateStoreChecklistItemDto } from '../dto/update-store-checklist.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

@ApiTags('Seller SEO — Store Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/store/:storeId/seo')
export class SellerStoreSeoController {
  constructor(
    private readonly storeSeo: StoreSeoService,
    private readonly db: DatabaseService,
  ) {}

  @RequirePermission('seo.view', 'seo.manage')
  @Get('dashboard')
  async getDashboard(@Req() req: any, @Param('storeId') storeId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.storeSeo.getDashboard(storeId);
  }

  @RequirePermission('seo.view', 'seo.manage')
  @Get('store')
  async getStoreSeo(@Req() req: any, @Param('storeId') storeId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.storeSeo.getStoreSeo(storeId);
  }

  @RequirePermission('seo.manage')
  @Patch('store')
  async updateStoreSeo(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateSeoMetaDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.storeSeo.updateStoreSeo(storeId, dto, { id: req.user.userId, role: req.user.role });
  }

  @RequirePermission('seo.view', 'seo.manage')
  @Get('store/checklist')
  async getChecklist(@Req() req: any, @Param('storeId') storeId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.storeSeo.getChecklist(storeId);
  }

  @RequirePermission('seo.manage')
  @Patch('store/checklist')
  async updateChecklist(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateStoreChecklistItemDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.storeSeo.updateChecklistItem(storeId, dto, { id: req.user.userId, role: req.user.role });
  }
}
