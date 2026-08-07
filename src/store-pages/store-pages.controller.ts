/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { StorePagesService } from './store-pages.service';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { UpdateSectionsDto } from './dto/update-sections.dto';

// Write routes are flag-gated (`storeBuilder`), matching `store-theme` and the
// `saveBuilderConfig` convention this module replaces; read routes stay ungated.
@ApiTags('Store Pages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/store-pages')
export class StorePagesController {
  constructor(private readonly storePagesService: StorePagesService) {}

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storePagesService.listForSeller(storeId, req.user.userId);
  }

  @Get(':storeId/:pageId')
  get(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.getForSeller(storeId, req.user.userId, pageId);
  }

  @UseGuards(FeatureFlagGuard)
  @RequireFeature('storeBuilder')
  @Post(':storeId')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreatePageDto) {
    return this.storePagesService.createPage(storeId, req.user.userId, dto);
  }

  @UseGuards(FeatureFlagGuard)
  @RequireFeature('storeBuilder')
  @Patch(':storeId/:pageId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string, @Body() dto: UpdatePageDto) {
    return this.storePagesService.updatePage(storeId, req.user.userId, pageId, dto);
  }

  @UseGuards(FeatureFlagGuard)
  @RequireFeature('storeBuilder')
  @Patch(':storeId/:pageId/sections')
  updateSections(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string, @Body() dto: UpdateSectionsDto) {
    return this.storePagesService.updateSections(storeId, req.user.userId, pageId, dto);
  }

  @UseGuards(FeatureFlagGuard)
  @RequireFeature('storeBuilder')
  @Patch(':storeId/:pageId/publish')
  publish(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.publish(storeId, req.user.userId, pageId);
  }

  @UseGuards(FeatureFlagGuard)
  @RequireFeature('storeBuilder')
  @Patch(':storeId/:pageId/unpublish')
  unpublish(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.unpublish(storeId, req.user.userId, pageId);
  }

  @UseGuards(FeatureFlagGuard)
  @RequireFeature('storeBuilder')
  @Delete(':storeId/:pageId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.deletePage(storeId, req.user.userId, pageId);
  }
}
