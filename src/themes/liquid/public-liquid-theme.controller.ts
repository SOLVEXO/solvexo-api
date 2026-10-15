import { Body, Controller, Get, Header, Param, ParseIntPipe, Post, Query, Res, StreamableFile, UsePipes, ValidationPipe } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { ThemePackageService } from './theme-package.service';
import { RenderLiquidThemeDto } from './dto/render-liquid-theme.dto';

// Public — no auth. A buyer visiting a storefront with an imported Liquid theme needs its rendered HTML and
// assets without logging in. Native-theme public routes live in ../../store-theme/public-store-theme.controller.ts.
@ApiTags('Liquid Theme (public)')
@Controller('api/public/store-theme')
export class PublicLiquidThemeController {
  constructor(private readonly themePackageService: ThemePackageService) {}

  @Get(':storeId/source/render')
  renderPublishedSource(@Param('storeId') storeId: string, @Query('path') path = '/') {
    return this.themePackageService.renderPublished(storeId, path);
  }

  @Post(':storeId/source/render')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  renderPublishedSourceWithCart(
    @Param('storeId') storeId: string,
    @Query('path') path = '/',
    @Body() body: RenderLiquidThemeDto,
  ) {
    return this.themePackageService.renderPublished(storeId, path, body.cartItems ?? []);
  }

  // Answers a theme's own `fetch('/recommendations/products.json?section_id=&product_id=&limit=')`. Returns
  // the re-rendered section HTML (not JSON) — see ThemePackageService.renderRecommendationsFragment.
  @Get(':storeId/source/recommendations')
  @Header('Content-Type', 'text/html; charset=utf-8')
  renderRecommendations(
    @Param('storeId') storeId: string,
    @Query('path') path = '/',
    @Query('sectionId') sectionId = '',
    @Query('productId') productId = '',
    @Query('limit') limit = '4',
  ) {
    return this.themePackageService.renderRecommendationsFragment(storeId, path, String(sectionId), String(productId), Number(limit) || 4);
  }

  // Theme assets (images, fonts, css, js): immutable per theme revision, so browsers and CDNs can cache them forever.
  @Get(':storeId/source/asset/:installedThemeId/:version')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  @Header('Access-Control-Allow-Origin', '*')
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  async getAsset(
    @Param('storeId') storeId: string,
    @Param('installedThemeId') installedThemeId: string,
    @Param('version', ParseIntPipe) version: number,
    @Query('path') path = '',
    @Res({ passthrough: true }) res: Response,
  ) {
    const { buffer, mime } = await this.themePackageService.getAssetFile(storeId, installedThemeId, version, String(path));
    res.setHeader('Content-Type', mime);
    return new StreamableFile(buffer);
  }
}
