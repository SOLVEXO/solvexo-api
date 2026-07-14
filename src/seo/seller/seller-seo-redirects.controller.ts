/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { DatabaseService } from 'src/database/databaseservice';
import { EntitlementsService } from 'src/platform-plans/entitlements.service';
import { verifyStoreOwnershipStrict } from 'src/common/store-ownership.util';
import { SeoRedirectsService } from '../services/seo-redirects.service';
import { CreateRedirectDto } from '../dto/create-redirect.dto';
import { UpdateRedirectDto } from '../dto/update-redirect.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

@ApiTags('Seller SEO — Redirects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
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

  @Post()
  async create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateRedirectDto) {
    await this.assertAccess(storeId, req.user.userId);
    return this.redirects.create(storeId, dto, { id: req.user.userId, role: req.user.role });
  }

  @Get()
  async list(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.redirects.list(storeId, query);
  }

  @Patch(':id')
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdateRedirectDto) {
    await this.assertAccess(storeId, req.user.userId);
    return this.redirects.update(storeId, id, dto, { id: req.user.userId, role: req.user.role });
  }

  @Delete(':id')
  async delete(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    await this.assertAccess(storeId, req.user.userId);
    return this.redirects.delete(storeId, id, { id: req.user.userId, role: req.user.role });
  }
}
