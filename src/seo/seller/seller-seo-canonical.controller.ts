/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { DatabaseService } from 'src/database/databaseservice';
import { EntitlementsService } from 'src/platform-plans/entitlements.service';
import { verifyStoreOwnershipStrict } from 'src/common/store-ownership.util';
import { SeoCanonicalService } from '../services/seo-canonical.service';
import { CreateCanonicalRuleDto } from '../dto/create-canonical-rule.dto';
import { UpdateCanonicalRuleDto } from '../dto/update-canonical-rule.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

@ApiTags('Seller SEO — Canonical Rules')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/store/:storeId/seo/canonical-rules')
export class SellerSeoCanonicalController {
  constructor(
    private readonly canonical: SeoCanonicalService,
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private async assertAccess(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, sellerId);
    await this.entitlements.assertFeatureAllowed(storeId, 'customRedirectsAllowed', 'Custom canonical rules');
  }

  @Post()
  async create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateCanonicalRuleDto) {
    await this.assertAccess(storeId, req.user.userId);
    return this.canonical.create(storeId, dto, { id: req.user.userId, role: req.user.role });
  }

  @Get()
  async list(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.canonical.list(storeId, query);
  }

  @Patch(':id')
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdateCanonicalRuleDto) {
    await this.assertAccess(storeId, req.user.userId);
    return this.canonical.update(storeId, id, dto, { id: req.user.userId, role: req.user.role });
  }

  @Delete(':id')
  async delete(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    await this.assertAccess(storeId, req.user.userId);
    return this.canonical.delete(storeId, id, { id: req.user.userId, role: req.user.role });
  }
}
