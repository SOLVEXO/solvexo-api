/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StoreThemeService } from './store-theme.service';
import { UpdateThemeDto } from './dto/update-theme.dto';
import { UpdateHeaderDto } from './dto/update-header.dto';
import { UpdateFooterDto } from './dto/update-footer.dto';
import { UpdateIdentityBannerDto } from './dto/update-identity-banner.dto';
import { UpdateCustomCssDto } from './dto/update-custom-css.dto';
import { InstallThemeDto } from './dto/install-theme.dto';
import { CreateColorSchemeDto } from './dto/color-scheme.dto';

@ApiTags('Store Theme')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/store-theme')
export class StoreThemeController {
  constructor(private readonly storeThemeService: StoreThemeService) {}

  // ── Theme Library (installed theme instances) — declared as static
  // segments ahead of the `:storeId/theme` etc. dynamic routes below is not
  // actually required here (none of these collide on segment count/shape),
  // but grouped together for readability since they're the Theme Library's
  // own surface, distinct from "edit the resolved instance". ──────────────

  @Get(':storeId/installed')
  listInstalled(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeThemeService.listInstalled(storeId, req.user.userId);
  }

  @Post(':storeId/install')
  install(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: InstallThemeDto) {
    return this.storeThemeService.installTheme(storeId, req.user.userId, dto);
  }

  @Post(':storeId/preview-link')
  createPreviewLink(@Req() req: any, @Param('storeId') storeId: string, @Query('instance') instance?: string) {
    return this.storeThemeService.createPreviewLink(storeId, req.user.userId, instance);
  }

  @Delete(':storeId/preview-link')
  revokePreviewLink(@Req() req: any, @Param('storeId') storeId: string, @Query('instance') instance?: string) {
    return this.storeThemeService.revokePreviewLink(storeId, req.user.userId, instance);
  }

  @Post(':storeId/installed/:installedThemeId/duplicate')
  duplicate(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('installedThemeId') installedThemeId: string,
    @Body('name') name?: string,
  ) {
    return this.storeThemeService.duplicateTheme(storeId, req.user.userId, installedThemeId, name);
  }

  @Patch(':storeId/installed/:installedThemeId/name')
  rename(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('installedThemeId') installedThemeId: string,
    @Body('name') name: string,
  ) {
    return this.storeThemeService.renameTheme(storeId, req.user.userId, installedThemeId, name);
  }

  @Post(':storeId/installed/:installedThemeId/activate')
  activate(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string) {
    return this.storeThemeService.activateTheme(storeId, req.user.userId, installedThemeId);
  }

  @Delete(':storeId/installed/:installedThemeId')
  uninstall(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string) {
    return this.storeThemeService.uninstallTheme(storeId, req.user.userId, installedThemeId);
  }

  // ── Resolved-instance surface — every route below operates on the row
  // named by `?instance=<installedThemeId>`, or the store's ACTIVE row when
  // that query param is omitted (the entire pre-existing frontend surface
  // never sends it, and keeps working unchanged). ─────────────────────────

  @Get(':storeId')
  get(@Req() req: any, @Param('storeId') storeId: string, @Query('instance') instance?: string) {
    return this.storeThemeService.getForSeller(storeId, req.user.userId, instance);
  }

  @Get(':storeId/draft')
  getDraft(@Req() req: any, @Param('storeId') storeId: string, @Query('instance') instance?: string) {
    return this.storeThemeService.getDraft(storeId, req.user.userId, instance);
  }

  @Post(':storeId/publish')
  publish(@Req() req: any, @Param('storeId') storeId: string, @Query('instance') instance?: string) {
    return this.storeThemeService.publishTheme(storeId, req.user.userId, instance);
  }

  @Post(':storeId/revert-draft')
  revertDraft(@Req() req: any, @Param('storeId') storeId: string, @Query('instance') instance?: string) {
    return this.storeThemeService.revertDraftToPublished(storeId, req.user.userId, instance);
  }

  @Get(':storeId/versions')
  listVersions(@Req() req: any, @Param('storeId') storeId: string, @Query('instance') instance?: string) {
    return this.storeThemeService.listVersions(storeId, req.user.userId, instance);
  }

  @Post(':storeId/versions/:versionId/restore')
  restoreVersion(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('versionId') versionId: string,
    @Query('instance') instance?: string,
  ) {
    return this.storeThemeService.restoreVersion(storeId, req.user.userId, versionId, instance);
  }

  @Patch(':storeId/theme')
  updateTheme(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateThemeDto, @Query('instance') instance?: string) {
    return this.storeThemeService.updateTheme(storeId, req.user.userId, dto, instance);
  }

  @Patch(':storeId/header')
  updateHeader(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateHeaderDto, @Query('instance') instance?: string) {
    return this.storeThemeService.updateHeader(storeId, req.user.userId, dto, instance);
  }

  @Patch(':storeId/footer')
  updateFooter(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateFooterDto, @Query('instance') instance?: string) {
    return this.storeThemeService.updateFooter(storeId, req.user.userId, dto, instance);
  }

  @Patch(':storeId/identity-banner')
  updateIdentityBanner(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Body() dto: UpdateIdentityBannerDto,
    @Query('instance') instance?: string,
  ) {
    return this.storeThemeService.updateIdentityBanner(storeId, req.user.userId, dto, instance);
  }

  @Post(':storeId/color-schemes')
  createColorScheme(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateColorSchemeDto, @Query('instance') instance?: string) {
    return this.storeThemeService.createColorScheme(storeId, req.user.userId, dto, instance);
  }

  @Delete(':storeId/color-schemes/:schemeId')
  deleteColorScheme(@Req() req: any, @Param('storeId') storeId: string, @Param('schemeId') schemeId: string, @Query('instance') instance?: string) {
    return this.storeThemeService.deleteColorScheme(storeId, req.user.userId, schemeId, instance);
  }

  @Post(':storeId/color-schemes/:schemeId/apply')
  applyColorScheme(@Req() req: any, @Param('storeId') storeId: string, @Param('schemeId') schemeId: string, @Query('instance') instance?: string) {
    return this.storeThemeService.applyColorScheme(storeId, req.user.userId, schemeId, instance);
  }

  @Patch(':storeId/custom-css')
  updateCustomCss(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateCustomCssDto, @Query('instance') instance?: string) {
    return this.storeThemeService.updateCustomCss(storeId, req.user.userId, dto.customCss ?? null, instance);
  }
}
