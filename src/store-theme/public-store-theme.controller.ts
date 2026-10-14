import { Body, Controller, Get, Header, Param, ParseIntPipe, Post, Query, Res, StreamableFile, UsePipes, ValidationPipe } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { StoreThemeService } from './store-theme.service';
import { ThemePackageService } from './theme-package.service';
import { RenderLiquidThemeDto } from './dto/render-liquid-theme.dto';

// Public — no auth. A buyer visiting a storefront needs its navbar/footer/theme
// without logging in. Own controller, same reasoning as PublicStoreBannerController.
@ApiTags('Store Theme (public)')
@Controller('api/public/store-theme')
export class PublicStoreThemeController {
  constructor(private readonly storeThemeService: StoreThemeService, private readonly themePackageService: ThemePackageService) {}

  @Get(':storeId')
  get(@Param('storeId') storeId: string) {
    return this.storeThemeService.getPublic(storeId);
  }

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

  // Real, shareable "see this before it's live" link — see `PreviewToken`'s
  // schema comment for the scope boundary. Declared as its own static
  // segment (`preview/:token`) ahead of nothing here since `:storeId` is
  // the only other route on this controller and doesn't collide.
  @Get(':storeId/preview/:token')
  getPreview(@Param('storeId') storeId: string, @Param('token') token: string) {
    return this.storeThemeService.getPreviewByToken(storeId, token);
  }
}
