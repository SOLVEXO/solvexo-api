/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Headers, Param, Patch, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { PosAuthGuard } from './guards/pos-auth.guard';
import { PosEntitlementGuard } from './guards/pos-entitlement.guard';
import { PosDeviceScopeInterceptor } from './pos-device-scope';
import { PosProductEditService, PRODUCT_IMAGE_MAX_BYTES } from './pos-product-edit.service';

/** G5.2 — the product page at the till and editing an existing product (details, a variant's SKU / cost / reorder point, photos). */
@ApiTags('POS catalog admin')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@UseInterceptors(PosDeviceScopeInterceptor)
@RequireFeature('posMode')
@Controller('api/pos/catalog-admin')
export class PosProductEditController {
  constructor(private readonly svc: PosProductEditService) {}
  private t = (e?: string) => ({ employee: e });

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('products/:storeId/:productId')
  view(@Req() req: any, @Param('storeId') s: string, @Param('productId') p: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.view(req, s, p, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Patch('products/:storeId/:productId')
  update(@Req() req: any, @Param('storeId') s: string, @Param('productId') p: string, @Body() b: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.update(req, s, p, b, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Patch('products/:storeId/:productId/variants/:variantId')
  updateVariant(@Req() req: any, @Param('storeId') s: string, @Param('productId') p: string, @Param('variantId') v: string, @Body() b: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.updateVariant(req, s, p, v, b, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: PRODUCT_IMAGE_MAX_BYTES } }))
  @Post('products/:storeId/:productId/images')
  addImage(@Req() req: any, @Param('storeId') s: string, @Param('productId') p: string, @UploadedFile() file: Express.Multer.File, @Headers('x-pos-employee-token') e?: string) { return this.svc.addImage(req, s, p, file, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Post('products/:storeId/:productId/images/remove')
  removeImage(@Req() req: any, @Param('storeId') s: string, @Param('productId') p: string, @Body() b: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.removeImage(req, s, p, b, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Post('products/:storeId/:productId/images/primary')
  primaryImage(@Req() req: any, @Param('storeId') s: string, @Param('productId') p: string, @Body() b: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.primaryImage(req, s, p, b, this.t(e)); }
}
