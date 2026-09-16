import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  Res,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { ProductsService } from './products.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { canViewProductCost, omitCostPrice, omitCostPriceFromVariants } from '../common/product-cost-visibility.util';
import { BillingAccessGuard } from '../platform-plans/guards/billing-access.guard';
import { RequireActiveBilling } from '../platform-plans/decorators/require-active-billing.decorator';

@Controller('api/products')
export class productController {
  constructor(private readonly ProductsService: ProductsService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Get('products-by-category')
  async getProductsByCategoryId(
    @Req() req: any,
    @Query('id') id?: string,
    @Query('page') pageQuery?: string,
    @Query('limit') limitQuery?: string,
    @Query('productType') productType?: string,
    @Query('educationLevel') educationLevel?: string,
    @Query('normalizedCustomLevel') normalizedCustomLevel?: string,
    @Query('campaignId') campaignId?: string,
    @Query('minPrice') minPriceQuery?: string,
    @Query('maxPrice') maxPriceQuery?: string,
    @Query('minRating') minRatingQuery?: string,
    @Query('sortBy') sortByQuery?: string,
    @Query('storeId') storeId?: string,
  ) {
    const page = Math.max(1, parseInt(pageQuery as string) || 1);
    const limit = Math.min(
      50,
      Math.max(1, parseInt(limitQuery as string) || 10),
    );
    const parseNum = (v?: string): number | undefined => {
      if (v === undefined) return undefined;
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const allowedSorts = [
      'newest',
      'price_asc',
      'price_desc',
      'rating',
      'popularity',
    ];
    const sortBy = allowedSorts.includes(sortByQuery as string)
      ? (sortByQuery as
          | 'newest'
          | 'price_asc'
          | 'price_desc'
          | 'rating'
          | 'popularity')
      : undefined;

    return this.ProductsService.getProductsByCategoryId(
      id,
      page,
      limit,
      req.user?.userId ?? null,
      productType,
      educationLevel,
      normalizedCustomLevel,
      campaignId,
      parseNum(minPriceQuery),
      parseNum(maxPriceQuery),
      parseNum(minRatingQuery),
      sortBy,
      storeId,
    );
  }

  @Get('education/facets')
  async getEducationFacets() {
    return this.ProductsService.getEducationFacets();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('education/custom-level-suggestions')
  async getCustomLevelSuggestions(@Query('q') q: string = '') {
    return this.ProductsService.getCustomLevelSuggestions(q);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('getProductById/:id')
  async getProductById(@Req() req: any, @Param('id') id: string, @Query('storeId') storeId?: string) {
    return this.ProductsService.getProductById(id, req.user?.userId ?? null, storeId);
  }

  @Get('getVariantById/:variantId')
  async getVariantById(@Param('variantId') variantId: string, @Query('storeId') storeId?: string) {
    return this.ProductsService.getVariantById(variantId, storeId);
  }

  // Public, pre-purchase preview of a digital product — watermarked/trimmed
  // derivative only, never the original file. Same guard as getProductById.
  @UseGuards(OptionalJwtAuthGuard)
  @Get('preview/:id')
  async getProductPreview(@Req() req: any, @Param('id') id: string, @Query('storeId') storeId?: string) {
    return this.ProductsService.getProductPreview(id, req.ip, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, BillingAccessGuard)
  @Roles('seller')
  @RequireActiveBilling()
  @Post('add-physical-product')
  async addPhysicalProduct(@Req() req: any, @Body() body: any) {
    const { userId: sellerId } = req.user;
    return this.ProductsService.addPhysicalProduct(sellerId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, BillingAccessGuard)
  @Roles('seller')
  @RequireActiveBilling()
  @Post('add-digital-product')
  async addDigitalProduct(@Req() req: any, @Body() body: any) {
    const { userId: sellerId } = req.user;
    return this.ProductsService.addDigitalProduct(sellerId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('products.view')
  @Get('get-my-product/:productId')
  async getSellerProductById(
    @Req() req: any,
    @Param('productId') productId: string,
  ) {
    const result: any = await this.ProductsService.getSellerProductById(actingSellerId(req.user), productId);
    // Real "View products" vs "View cost" split — see products.view_cost's
    // doc comment (common/product-cost-visibility.util.ts).
    if (!canViewProductCost(req.user)) {
      result.data.variants = omitCostPriceFromVariants(result.data.variants);
      result.data.defaultVariant = result.data.defaultVariant ? omitCostPrice(result.data.defaultVariant) : null;
    }
    return result;
  }

  // ── Storefront promotion sections — public, no auth required ──────────────
  @UseGuards(OptionalJwtAuthGuard)
  @Get('store/:storeId/pinned')
  async getPinnedProducts(@Req() req: any, @Param('storeId') storeId: string) {
    return this.ProductsService.getPinnedProducts(storeId, req.user?.userId ?? null);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('store/:storeId/new-arrivals')
  async getNewArrivals(@Req() req: any, @Param('storeId') storeId: string, @Query('limit') limitQuery?: string) {
    const limit = Math.min(24, Math.max(1, parseInt(limitQuery as string) || 12));
    return this.ProductsService.getNewArrivals(storeId, limit, req.user?.userId ?? null);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('store/:storeId/best-sellers')
  async getBestSellers(@Req() req: any, @Param('storeId') storeId: string, @Query('limit') limitQuery?: string) {
    const limit = Math.min(24, Math.max(1, parseInt(limitQuery as string) || 12));
    return this.ProductsService.getBestSellers(storeId, limit, req.user?.userId ?? null);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('store/:storeId/trending')
  async getTrendingProducts(@Req() req: any, @Param('storeId') storeId: string, @Query('limit') limitQuery?: string) {
    const limit = Math.min(24, Math.max(1, parseInt(limitQuery as string) || 12));
    return this.ProductsService.getTrendingProducts(storeId, limit, req.user?.userId ?? null);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('products.view')
  @Get('store-products/:storeId')
  async getStoreProducts(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: any,
  ) {
    const result: any = await this.ProductsService.getStoreProducts(actingSellerId(req.user), storeId, query);
    if (!canViewProductCost(req.user)) {
      result.data.products = result.data.products.map((p: any) => ({ ...p, variants: omitCostPriceFromVariants(p.variants) }));
    }
    return result;
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('products.export')
  @Get('store-products/:storeId/export')
  async exportProductsCsv(@Req() req: any, @Res() res: Response, @Param('storeId') storeId: string) {
    const csv = await this.ProductsService.exportProductsCsv(actingSellerId(req.user), storeId);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="products.csv"');
    res.send(csv);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, BillingAccessGuard)
  @Roles('seller')
  @RequireActiveBilling()
  @Post('store-products/:storeId/import')
  @UseInterceptors(
    FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  async importProductsCsv(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const { userId: sellerId } = req.user;
    if (!file) throw new BadRequestException('No CSV file uploaded');
    return this.ProductsService.importProductsCsv(sellerId, storeId, file.buffer.toString('utf-8'));
  }

  // Gated the same as add-physical-product/add-digital-product — the
  // BillingAccessGuard's own decorator doc names "creating/editing products"
  // as its intended scope, but this route was missed when the guard was
  // first wired up (found while re-verifying the 'locked' enforcement).
  // Tier-2 real split of the Products edit/price fusion the Tier-1 audit
  // flagged as Partial: `products.edit` is the baseline for a staff caller;
  // touching `price`/`compareAtPrice` (only ever applied here for a
  // digital/educational product's default variant — see
  // ProductsService.editProduct's own doc comment) additionally requires
  // `products.edit_price`, same imperative-check shape as
  // `product-variants.controller.ts`'s real physical-variant split.
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, BillingAccessGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('products.edit')
  @RequireActiveBilling()
  @Post('edit-product')
  async editProduct(@Req() req: any, @Body() body: any) {
    if (req.user.role === 'staff' && (body?.price !== undefined || body?.compareAtPrice !== undefined)) {
      const permissions: string[] = Array.isArray(req.user.permissions) ? req.user.permissions : [];
      if (!permissions.includes('products.edit_price')) {
        throw new ForbiddenException("Your staff account doesn't have permission to edit product prices.");
      }
    }
    return this.ProductsService.editProduct(actingSellerId(req.user), body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('products.delete')
  @Delete('delete-product/:productId')
  async deleteProduct(@Req() req: any, @Param('productId') productId: string) {
    return this.ProductsService.deleteProduct(actingSellerId(req.user), productId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('duplicate-product/:productId')
  async duplicateProduct(@Req() req: any, @Param('productId') productId: string) {
    const { userId: sellerId } = req.user;
    return this.ProductsService.duplicateProduct(sellerId, productId);
  }
}
