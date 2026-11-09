/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Put, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { SearchDiscoveryService } from './search-discovery.service';

/** Seller search settings: synonyms, pinned products, filters, and the "no results" report. Permission: onlinestore.themes.manage (store design). */
@ApiTags('Search & discovery (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/search-discovery/:storeId')
export class SearchDiscoveryController {
  constructor(private readonly svc: SearchDiscoveryService, private readonly db: DatabaseService) {}
  private own(req: any, s: string) { return verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, s, actingSellerId(req.user)); }
  @Get() @RequirePermission('onlinestore.themes.manage') async get(@Req() r: any, @Param('storeId') s: string) { await this.own(r, s); return this.svc.getConfig(s); }
  @Put() @RequirePermission('onlinestore.themes.manage') async put(@Req() r: any, @Param('storeId') s: string, @Body() b: any) { await this.own(r, s); return this.svc.save(s, b); }
  @Get('no-results') @RequirePermission('onlinestore.themes.manage') async misses(@Req() r: any, @Param('storeId') s: string, @Query() q: any) { await this.own(r, s); return this.svc.noResults(s, q); }
  @Delete('no-results') @RequirePermission('onlinestore.themes.manage') async clear(@Req() r: any, @Param('storeId') s: string, @Query('query') q: string) { await this.own(r, s); return this.svc.clearMiss(s, q); }
}

@ApiTags('Search & discovery (public)')
@Controller('api/public/search-config')
export class PublicSearchConfigController {
  constructor(private readonly svc: SearchDiscoveryService) {}
  @Get(':storeId') @Throttle({ default: { limit: 120, ttl: 60_000 } })
  filters(@Param('storeId') s: string) { return this.svc.publicFilters(s); }
}
