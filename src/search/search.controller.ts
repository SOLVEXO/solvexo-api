/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from 'src/auth/guards/optional-jwt-auth.guard';
import { SearchService } from './search.service';

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
    return this.searchService.searchProducts(query.q ?? '', page, limit, req.user?.userId ?? null);
  }

  @UseGuards(JwtAuthGuard)
  @Get('recent')
  getRecentSearches(@Req() req: any, @Query() query: any) {
    const limit = Math.max(1, parseInt(query.limit) || 10);
    return this.searchService.getRecentSearches(req.user.userId, limit);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('recent')
  clearRecentSearches(@Req() req: any) {
    return this.searchService.clearRecentSearches(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('recent/:searchId')
  deleteRecentSearch(@Req() req: any, @Param('searchId') searchId: string) {
    return this.searchService.deleteRecentSearch(req.user.userId, searchId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('recently-viewed')
  getRecentlyViewed(@Req() req: any, @Query() query: any) {
    const limit = Math.max(1, parseInt(query.limit) || 10);
    return this.searchService.getRecentlyViewed(req.user.userId, limit);
  }

  @UseGuards(JwtAuthGuard)
  @Post('recently-viewed')
  recordProductView(@Req() req: any, @Body('productId') productId: string) {
    return this.searchService.recordProductView(req.user.userId, productId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('recently-viewed')
  clearRecentlyViewed(@Req() req: any) {
    return this.searchService.clearRecentlyViewed(req.user.userId);
  }
}
