/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { StorePagesService } from './store-pages.service';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { UpdateSectionsDto } from './dto/update-sections.dto';

// Gated on `onlinestore.content.manage` — this same controller covers BOTH
// Shopify's "Blog posts and pages" (Online Store) AND "Manage store
// policies" (Settings) permissions, since a policy page in Solvexo is just
// a `StorePage` with `policyType` set — there's no route-level way to
// separate the two (see this pass's own disclosed-merge note).
@ApiTags('Store Pages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('onlinestore.content.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/store-pages')
export class StorePagesController {
  constructor(private readonly storePagesService: StorePagesService) {}

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storePagesService.listForSeller(storeId, actingSellerId(req.user));
  }

  @Get(':storeId/:pageId')
  get(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.getForSeller(storeId, actingSellerId(req.user), pageId);
  }

  @Get(':storeId/:pageId/draft')
  getDraft(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.getDraft(storeId, actingSellerId(req.user), pageId);
  }

  @Post(':storeId')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreatePageDto) {
    return this.storePagesService.createPage(storeId, actingSellerId(req.user), dto);
  }

  @Patch(':storeId/:pageId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string, @Body() dto: UpdatePageDto) {
    return this.storePagesService.updatePage(storeId, actingSellerId(req.user), pageId, dto);
  }

  @Patch(':storeId/:pageId/sections')
  updateSections(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string, @Body() dto: UpdateSectionsDto) {
    return this.storePagesService.updateSections(storeId, actingSellerId(req.user), pageId, dto);
  }

  @Patch(':storeId/:pageId/publish')
  publish(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.publish(storeId, actingSellerId(req.user), pageId);
  }

  @Patch(':storeId/:pageId/unpublish')
  unpublish(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.unpublish(storeId, actingSellerId(req.user), pageId);
  }

  @Patch(':storeId/:pageId/revert-draft')
  revertDraft(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.revertDraft(storeId, actingSellerId(req.user), pageId);
  }

  @Get(':storeId/:pageId/versions')
  listVersions(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.listVersions(storeId, actingSellerId(req.user), pageId);
  }

  @Post(':storeId/:pageId/versions/:versionId/restore')
  restoreVersion(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string, @Param('versionId') versionId: string) {
    return this.storePagesService.restoreVersion(storeId, actingSellerId(req.user), pageId, versionId);
  }

  @Delete(':storeId/:pageId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.deletePage(storeId, actingSellerId(req.user), pageId);
  }
}
