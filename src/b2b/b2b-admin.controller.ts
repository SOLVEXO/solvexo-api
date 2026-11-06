/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { B2BAdminService } from './b2b-admin.service';
import { EntitlementsService } from '../platform-plans/entitlements.service';

/** Seller B2B admin (wholesale companies, locations, buyers, catalogs, applications). Permissions: b2b.view / b2b.manage. */
@ApiTags('B2B (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/b2b/:storeId')
export class B2BAdminController {
  constructor(private readonly svc: B2BAdminService, private readonly db: DatabaseService, private readonly entitlements: EntitlementsService) {}
  /** `write` = a change: the store's plan must include wholesale (reading what already exists is always allowed). */
  private async own(req: any, storeId: string, write = false) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, actingSellerId(req.user));
    if (write) await this.entitlements.assertFeatureAllowed(storeId, 'b2bWholesaleAllowed', 'Wholesale (B2B)');
    return { id: String(req.user.userId ?? req.user.sub ?? req.user.id ?? ''), role: String(req.user.role) };
  }

  @Get('companies') @RequirePermission('b2b.view')
  async companies(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { await this.own(req, s); return this.svc.listCompanies(s, q); }
  @Get('companies/:id') @RequirePermission('b2b.view')
  async company(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { await this.own(req, s); return this.svc.getCompany(s, id); }
  @Post('companies') @RequirePermission('b2b.manage')
  async createCompany(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { return this.svc.createCompany(s, await this.own(req, s, true), b); }
  @Patch('companies/:id') @RequirePermission('b2b.manage')
  async updateCompany(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { return this.svc.updateCompany(s, await this.own(req, s, true), id, b); }
  @Delete('companies/:id') @RequirePermission('b2b.manage')
  async deleteCompany(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { return this.svc.deleteCompany(s, await this.own(req, s, true), id); }

  @Post('companies/:id/locations') @RequirePermission('b2b.manage')
  async createLocation(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { return this.svc.createLocation(s, await this.own(req, s, true), id, b); }
  @Patch('locations/:id') @RequirePermission('b2b.manage')
  async updateLocation(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { return this.svc.updateLocation(s, await this.own(req, s, true), id, b); }
  @Delete('locations/:id') @RequirePermission('b2b.manage')
  async deleteLocation(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { return this.svc.deleteLocation(s, await this.own(req, s, true), id); }

  @Post('locations/:id/buyers') @RequirePermission('b2b.manage')
  async addBuyer(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { return this.svc.addBuyer(s, await this.own(req, s, true), id, b); }
  @Patch('buyers/:id') @RequirePermission('b2b.manage')
  async updateBuyer(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { return this.svc.updateBuyer(s, await this.own(req, s, true), id, b); }
  @Delete('buyers/:id') @RequirePermission('b2b.manage')
  async removeBuyer(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { return this.svc.removeBuyer(s, await this.own(req, s, true), id); }

  @Get('applications') @RequirePermission('b2b.view')
  async applications(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { await this.own(req, s); return this.svc.listApplications(s, q); }
  @Post('applications/:id/approve') @RequirePermission('b2b.manage')
  async approve(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { return this.svc.approveApplication(s, await this.own(req, s, true), id, b); }
  @Post('applications/:id/reject') @RequirePermission('b2b.manage')
  async reject(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { return this.svc.rejectApplication(s, await this.own(req, s, true), id, b); }

  @Get('catalogs') @RequirePermission('b2b.view')
  async catalogs(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return this.svc.listCatalogs(s); }
  @Post('catalogs') @RequirePermission('b2b.manage')
  async createCatalog(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { return this.svc.createCatalog(s, await this.own(req, s, true), b); }
  @Patch('catalogs/:id') @RequirePermission('b2b.manage')
  async updateCatalog(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { return this.svc.updateCatalog(s, await this.own(req, s, true), id, b); }
  @Delete('catalogs/:id') @RequirePermission('b2b.manage')
  async deleteCatalog(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { return this.svc.deleteCatalog(s, await this.own(req, s, true), id); }
  @Get('catalogs/:id/items') @RequirePermission('b2b.view')
  async items(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Query() q: any) { await this.own(req, s); return this.svc.listCatalogItems(s, id, q); }
  @Put('catalogs/:id/items') @RequirePermission('b2b.manage')
  async saveItems(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { return this.svc.upsertCatalogItems(s, await this.own(req, s, true), id, b?.items); }
  @Delete('catalogs/:id/items/:variantId') @RequirePermission('b2b.manage')
  async removeItem(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Param('variantId') v: string) { return this.svc.removeCatalogItem(s, await this.own(req, s, true), id, v); }
}
