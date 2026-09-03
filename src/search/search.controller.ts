/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '@/auth/guards/optional-jwt-auth.guard';
import { SearchService } from './search.service';
import { resolveBuyerStoreScope } from '../common/store-scope.util';

/** Buyer search: keyword product search (public; history recorded when a JWT
 *  is present) plus the per-user recent-searches and recently-viewed lists
 *  behind it. History routes need only a login, not a role — a seller
 *  browsing as a customer gets the same experience. */
@Controller('api/search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Get('products')
  searchProducts(@Req() req: any, @Query() query: any) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(50, parseInt(query.limit) || 20);
    return this.searchService.searchProducts(query.q ?? '', page, limit, req.user?.userId ?? null, query.storeId);
  }

  @Get('stores')
  searchStores(@Query() query: any) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(50, parseInt(query.limit) || 20);
    return this.searchService.searchStores(query.q ?? '', page, limit);
  }

  @UseGuards(JwtAuthGuard)
  @Get('recent')
  getRecentSearches(@Req() req: any, @Query() query: any) {
    const limit = Math.max(1, parseInt(query.limit) || 10);
    const storeId = resolveBuyerStoreScope(req.user.storeId, query.storeId);
    return this.searchService.getRecentSearches(req.user.userId, limit, storeId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('recent')
  clearRecentSearches(@Req() req: any, @Query('storeId') storeIdQuery: string) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, storeIdQuery);
    return this.searchService.clearRecentSearches(req.user.userId, storeId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('recent/:searchId')
  deleteRecentSearch(@Req() req: any, @Param('searchId') searchId: string, @Query('storeId') storeIdQuery: string) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, storeIdQuery);
    return this.searchService.deleteRecentSearch(req.user.userId, searchId, storeId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('recently-viewed')
  getRecentlyViewed(@Req() req: any, @Query() query: any) {
    const limit = Math.max(1, parseInt(query.limit) || 10);
    const storeId = resolveBuyerStoreScope(req.user.storeId, query.storeId);
    return this.searchService.getRecentlyViewed(req.user.userId, limit, storeId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('recently-viewed')
  recordProductView(@Req() req: any, @Body('productId') productId: string, @Body('storeId') storeIdBody: string) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, storeIdBody);
    return this.searchService.recordProductView(req.user.userId, productId, storeId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('recently-viewed')
  clearRecentlyViewed(@Req() req: any, @Query('storeId') storeIdQuery: string) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, storeIdQuery);
    return this.searchService.clearRecentlyViewed(req.user.userId, storeId);
  }
}
