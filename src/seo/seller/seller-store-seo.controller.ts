/* eslint-disable prettier/prettier */
import { Controller, Get, Patch, Param, Body, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { DatabaseService } from '@/database/databaseservice';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { StoreSeoService } from '../services/store-seo.service';
import { UpdateSeoMetaDto } from '../dto/update-seo-meta.dto';
import { UpdateStoreChecklistItemDto } from '../dto/update-store-checklist.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

@ApiTags('Seller SEO — Store Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/store/:storeId/seo')
export class SellerStoreSeoController {
  constructor(
    private readonly storeSeo: StoreSeoService,
    private readonly db: DatabaseService,
  ) {}

  @Get('dashboard')
  async getDashboard(@Req() req: any, @Param('storeId') storeId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.storeSeo.getDashboard(storeId);
  }

  @Get('store')
  async getStoreSeo(@Req() req: any, @Param('storeId') storeId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.storeSeo.getStoreSeo(storeId);
  }

  @Patch('store')
  async updateStoreSeo(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateSeoMetaDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.storeSeo.updateStoreSeo(storeId, dto, { id: req.user.userId, role: req.user.role });
  }

  @Get('store/checklist')
  async getChecklist(@Req() req: any, @Param('storeId') storeId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.storeSeo.getChecklist(storeId);
  }

  @Patch('store/checklist')
  async updateChecklist(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateStoreChecklistItemDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.storeSeo.updateChecklistItem(storeId, dto, { id: req.user.userId, role: req.user.role });
  }
}
