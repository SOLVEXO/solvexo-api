import { Body, Controller, Get, Param, Post, Query, UsePipes, ValidationPipe } from '@nestjs/common';
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

  // Real, shareable "see this before it's live" link — see `PreviewToken`'s
  // schema comment for the scope boundary. Declared as its own static
  // segment (`preview/:token`) ahead of nothing here since `:storeId` is
  // the only other route on this controller and doesn't collide.
  @Get(':storeId/preview/:token')
  getPreview(@Param('storeId') storeId: string, @Param('token') token: string) {
    return this.storeThemeService.getPreviewByToken(storeId, token);
  }
}
