/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { StoreThemeService } from './store-theme.service';
import { UpdateThemeDto } from './dto/update-theme.dto';
import { UpdateHeaderDto } from './dto/update-header.dto';
import { UpdateFooterDto } from './dto/update-footer.dto';
import { UpdateIdentityBannerDto } from './dto/update-identity-banner.dto';

// Write routes are flag-gated (`storeBuilder`), matching the existing
// `saveBuilderConfig` convention this module replaces; the read route stays
// ungated, same asymmetry as today's `getBuilderConfig`.
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

  @UseGuards(FeatureFlagGuard)
  @RequireFeature('storeBuilder')
  @Patch(':storeId/theme')
  updateTheme(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateThemeDto) {
    return this.storeThemeService.updateTheme(storeId, req.user.userId, dto);
  }

  @UseGuards(FeatureFlagGuard)
  @RequireFeature('storeBuilder')
  @Patch(':storeId/header')
  updateHeader(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateHeaderDto) {
    return this.storeThemeService.updateHeader(storeId, req.user.userId, dto);
  }

  @UseGuards(FeatureFlagGuard)
  @RequireFeature('storeBuilder')
  @Patch(':storeId/footer')
  updateFooter(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateFooterDto) {
    return this.storeThemeService.updateFooter(storeId, req.user.userId, dto);
  }

  @UseGuards(FeatureFlagGuard)
  @RequireFeature('storeBuilder')
  @Patch(':storeId/identity-banner')
  updateIdentityBanner(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateIdentityBannerDto) {
    return this.storeThemeService.updateIdentityBanner(storeId, req.user.userId, dto);
  }
}
