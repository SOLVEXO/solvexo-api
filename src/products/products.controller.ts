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
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { ProductsService } from './products.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('get-my-product/:productId')
  async getSellerProductById(
    @Req() req: any,
    @Param('productId') productId: string,
  ) {
    const { userId: sellerId } = req.user;
    return this.ProductsService.getSellerProductById(sellerId, productId);
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('store-products/:storeId')
  async getStoreProducts(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: any,
  ) {
    const { userId: sellerId } = req.user;
    return this.ProductsService.getStoreProducts(sellerId, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('store-products/:storeId/export')
  async exportProductsCsv(@Req() req: any, @Res() res: Response, @Param('storeId') storeId: string) {
    const { userId: sellerId } = req.user;
    const csv = await this.ProductsService.exportProductsCsv(sellerId, storeId);
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
  @UseGuards(JwtAuthGuard, RolesGuard, BillingAccessGuard)
  @Roles('seller')
  @RequireActiveBilling()
  @Post('edit-product')
  async editProduct(@Req() req: any, @Body() body: any) {
    const { userId: sellerId } = req.user;
    return this.ProductsService.editProduct(sellerId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete('delete-product/:productId')
  async deleteProduct(@Req() req: any, @Param('productId') productId: string) {
    const { userId: sellerId } = req.user;
    return this.ProductsService.deleteProduct(sellerId, productId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('duplicate-product/:productId')
  async duplicateProduct(@Req() req: any, @Param('productId') productId: string) {
    const { userId: sellerId } = req.user;
    return this.ProductsService.duplicateProduct(sellerId, productId);
  }
}
