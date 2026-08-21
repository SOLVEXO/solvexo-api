/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { StoreThemeService } from './store-theme.service';
import { UpdateThemeDto } from './dto/update-theme.dto';
import { UpdateHeaderDto } from './dto/update-header.dto';
import { UpdateFooterDto } from './dto/update-footer.dto';
import { UpdateIdentityBannerDto } from './dto/update-identity-banner.dto';
import { UpdateCustomCssDto } from './dto/update-custom-css.dto';

@ApiTags('Store Theme')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/store-theme')
export class StoreThemeController {
  constructor(private readonly storeThemeService: StoreThemeService) {}

  @Get(':storeId')
  get(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeThemeService.getForSeller(storeId, req.user.userId);
  }

  @Get(':storeId/draft')
  getDraft(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeThemeService.getDraft(storeId, req.user.userId);
  }

  @Post(':storeId/publish')
  publish(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeThemeService.publishTheme(storeId, req.user.userId);
  }

  @Post(':storeId/revert-draft')
  revertDraft(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeThemeService.revertDraftToPublished(storeId, req.user.userId);
  }

  // Theme Marketplace "Use Theme" — idempotency-guarded the same way
  // `checkout.controller.ts#createCheckout` is, since a flaky mobile client
  // retrying this must never double-apply/double-count `applyCount`.
  @Post(':storeId/apply/:themeDefinitionId')
  @UseInterceptors(IdempotencyInterceptor)
  applyTheme(@Req() req: any, @Param('storeId') storeId: string, @Param('themeDefinitionId') themeDefinitionId: string) {
    return this.storeThemeService.applyThemeDefinition(storeId, req.user.userId, themeDefinitionId);
  }

  @Patch(':storeId/theme')
  updateTheme(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateThemeDto) {
    return this.storeThemeService.updateTheme(storeId, req.user.userId, dto);
  }

  @Patch(':storeId/header')
  updateHeader(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateHeaderDto) {
    return this.storeThemeService.updateHeader(storeId, req.user.userId, dto);
  }

  @Patch(':storeId/footer')
  updateFooter(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateFooterDto) {
    return this.storeThemeService.updateFooter(storeId, req.user.userId, dto);
  }

  @Patch(':storeId/identity-banner')
  updateIdentityBanner(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateIdentityBannerDto) {
    return this.storeThemeService.updateIdentityBanner(storeId, req.user.userId, dto);
  }

  @Patch(':storeId/custom-css')
  updateCustomCss(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateCustomCssDto) {
    return this.storeThemeService.updateCustomCss(storeId, req.user.userId, dto);
  }
}
