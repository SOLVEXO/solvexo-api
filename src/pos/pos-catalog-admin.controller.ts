/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { PosAuthGuard } from './guards/pos-auth.guard';
import { PosEntitlementGuard } from './guards/pos-entitlement.guard';
import { PosDeviceScopeInterceptor } from './pos-device-scope';
import { PosCatalogAdminService } from './pos-catalog-admin.service';

/** G4.5 — products & pricing from the till: product / variant creation, categories, CSV import, modifier groups, price books. WHO may do WHAT is the permission matrix. */
@ApiTags('POS catalog admin')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@UseInterceptors(PosDeviceScopeInterceptor)
@RequireFeature('posMode')
@Controller('api/pos/catalog-admin')
export class PosCatalogAdminController {
  constructor(private readonly svc: PosCatalogAdminService) {}
  private t = (e?: string) => ({ employee: e });

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post('products/:storeId')
  createProduct(@Req() req: any, @Param('storeId') s: string, @Body() b: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.createProduct(req, s, b, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post('products/:storeId/:productId/variants')
  addVariant(@Req() req: any, @Param('storeId') s: string, @Param('productId') p: string, @Body() b: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.addVariant(req, s, p, b, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Post('products/:storeId/:productId/variants/:variantId/archive')
  archiveVariant(@Req() req: any, @Param('storeId') s: string, @Param('productId') p: string, @Param('variantId') v: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.archiveVariant(req, s, p, v, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('categories/:storeId')
  categories(@Req() req: any, @Param('storeId') s: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.categoryList(req, s, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Post('categories/:storeId')
  categoryCreate(@Req() req: any, @Param('storeId') s: string, @Body() b: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.categoryCreate(req, s, b, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Patch('categories/:storeId/:id')
  categoryUpdate(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.categoryUpdate(req, s, id, b, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Post('categories/:storeId/:id/delete')
  categoryDelete(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.categoryDelete(req, s, id, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Post('import/:storeId')
  importCsv(@Req() req: any, @Param('storeId') s: string, @Body() b: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.importCsv(req, s, b, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('modifiers/:storeId')
  modifiers(@Req() req: any, @Param('storeId') s: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.modifierGroups(req, s, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Post('modifiers/:storeId')
  modifierCreate(@Req() req: any, @Param('storeId') s: string, @Body() b: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.modifierCreate(req, s, b, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Patch('modifiers/:storeId/:id')
  modifierUpdate(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.modifierUpdate(req, s, id, b, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('price-books/:storeId')
  priceBooks(@Req() req: any, @Param('storeId') s: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.priceBooks(req, s, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Post('price-books/:storeId')
  priceBookCreate(@Req() req: any, @Param('storeId') s: string, @Body() b: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.priceBookCreate(req, s, b, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Patch('price-books/:storeId/:id')
  priceBookUpdate(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.priceBookUpdate(req, s, id, b, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Post('price-books/:storeId/customers/:customerId')
  assignBook(@Req() req: any, @Param('storeId') s: string, @Param('customerId') c: string, @Body() b: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.assignBook(req, s, c, b, this.t(e)); }
}
