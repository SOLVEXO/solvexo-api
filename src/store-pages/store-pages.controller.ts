/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StorePagesService } from './store-pages.service';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { UpdateSectionsDto } from './dto/update-sections.dto';

@ApiTags('Store Pages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
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

  @Get(':storeId/:pageId/draft')
  getDraft(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.getDraft(storeId, req.user.userId, pageId);
  }

  @Post(':storeId')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreatePageDto) {
    return this.storePagesService.createPage(storeId, req.user.userId, dto);
  }

  @Patch(':storeId/:pageId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string, @Body() dto: UpdatePageDto) {
    return this.storePagesService.updatePage(storeId, req.user.userId, pageId, dto);
  }

  @Patch(':storeId/:pageId/sections')
  updateSections(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string, @Body() dto: UpdateSectionsDto) {
    return this.storePagesService.updateSections(storeId, req.user.userId, pageId, dto);
  }

  @Patch(':storeId/:pageId/publish')
  publish(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.publish(storeId, req.user.userId, pageId);
  }

  @Patch(':storeId/:pageId/unpublish')
  unpublish(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.unpublish(storeId, req.user.userId, pageId);
  }

  @Patch(':storeId/:pageId/revert-draft')
  revertDraft(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.revertDraft(storeId, req.user.userId, pageId);
  }

  @Get(':storeId/:pageId/versions')
  listVersions(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.listVersions(storeId, req.user.userId, pageId);
  }

  @Post(':storeId/:pageId/versions/:versionId/restore')
  restoreVersion(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string, @Param('versionId') versionId: string) {
    return this.storePagesService.restoreVersion(storeId, req.user.userId, pageId, versionId);
  }

  @Delete(':storeId/:pageId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    return this.storePagesService.deletePage(storeId, req.user.userId, pageId);
  }
}
