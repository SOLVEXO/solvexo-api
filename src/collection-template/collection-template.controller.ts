/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CollectionTemplateService } from './collection-template.service';
import { UpdateSectionsDto } from '../store-pages/dto/update-sections.dto';

// Singleton-per-store — no `:templateId` param anywhere, unlike StorePages
// (which is 1:N per store). Same guard/pipe stack as `StorePagesController`.
@ApiTags('Collection Template')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/collection-template')
export class CollectionTemplateController {
  constructor(private readonly collectionTemplateService: CollectionTemplateService) {}

  @Get(':storeId')
  get(@Req() req: any, @Param('storeId') storeId: string) {
    return this.collectionTemplateService.getForSeller(storeId, req.user.userId);
  }

  @Get(':storeId/draft')
  getDraft(@Req() req: any, @Param('storeId') storeId: string) {
    return this.collectionTemplateService.getDraft(storeId, req.user.userId);
  }

  @Patch(':storeId/sections')
  updateSections(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateSectionsDto) {
    return this.collectionTemplateService.updateSections(storeId, req.user.userId, dto);
  }

  @Patch(':storeId/publish')
  publish(@Req() req: any, @Param('storeId') storeId: string) {
    return this.collectionTemplateService.publish(storeId, req.user.userId);
  }

  @Patch(':storeId/revert-draft')
  revertDraft(@Req() req: any, @Param('storeId') storeId: string) {
    return this.collectionTemplateService.revertDraft(storeId, req.user.userId);
  }

  @Get(':storeId/versions')
  listVersions(@Req() req: any, @Param('storeId') storeId: string) {
    return this.collectionTemplateService.listVersions(storeId, req.user.userId);
  }

  @Post(':storeId/versions/:versionId/restore')
  restoreVersion(@Req() req: any, @Param('storeId') storeId: string, @Param('versionId') versionId: string) {
    return this.collectionTemplateService.restoreVersion(storeId, req.user.userId, versionId);
  }
}
