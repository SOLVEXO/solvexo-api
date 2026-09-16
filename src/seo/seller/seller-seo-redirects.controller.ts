/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { PermissionsGuard } from '@/auth/guards/permissions.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { RequirePermission } from '@/auth/decorators/require-permission.decorator';
import { DatabaseService } from '@/database/databaseservice';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { actingSellerId } from '@/common/acting-seller-id.util';
import { SeoRedirectsService } from '../services/seo-redirects.service';
import { CreateRedirectDto } from '../dto/create-redirect.dto';
import { UpdateRedirectDto } from '../dto/update-redirect.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

@ApiTags('Seller SEO — Redirects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/store/:storeId/seo/redirects')
export class SellerSeoRedirectsController {
  constructor(
    private readonly redirects: SeoRedirectsService,
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private async assertAccess(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, sellerId);
    await this.entitlements.assertFeatureAllowed(storeId, 'customRedirectsAllowed', 'Custom redirects');
  }

  @RequirePermission('seo.manage')
  @Post()
  async create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateRedirectDto) {
    await this.assertAccess(storeId, actingSellerId(req.user));
    return this.redirects.create(storeId, dto, { id: req.user.userId, role: req.user.role });
  }

  @RequirePermission('seo.view', 'seo.manage')
  @Get()
  async list(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.redirects.list(storeId, query);
  }

  @RequirePermission('seo.manage')
  @Patch(':id')
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdateRedirectDto) {
    await this.assertAccess(storeId, actingSellerId(req.user));
    return this.redirects.update(storeId, id, dto, { id: req.user.userId, role: req.user.role });
  }

  @RequirePermission('seo.manage')
  @Delete(':id')
  async delete(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    await this.assertAccess(storeId, actingSellerId(req.user));
    return this.redirects.delete(storeId, id, { id: req.user.userId, role: req.user.role });
  }
}
