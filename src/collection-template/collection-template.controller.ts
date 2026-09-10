/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CollectionTemplateService } from './collection-template.service';
import { UpdateSectionsDto } from '../store-pages/dto/update-sections.dto';
import { CreateResourceTemplateDto } from './dto/create-resource-template.dto';
import { ResourceTemplateType } from './schemas/collection-template.schema';

// Generalized from a Collection-only singleton into "alternate templates for
// a resource type" (Collection AND Product) — every route accepts optional
// `?resourceType=` (default `'collection'`, preserving 100% of the original
// behavior/URL shape for every pre-existing caller) and `?templateKey=`
// (default `'default'`).
@ApiTags('Resource Templates (Collection / Product)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/collection-template')
export class CollectionTemplateController {
  constructor(private readonly collectionTemplateService: CollectionTemplateService) {}

  private resourceType(q?: string): ResourceTemplateType {
    return (q as ResourceTemplateType) ?? 'collection';
  }

  @Get(':storeId/templates')
  listTemplates(@Req() req: any, @Param('storeId') storeId: string, @Query('resourceType') resourceType?: string) {
    return this.collectionTemplateService.listTemplates(storeId, req.user.userId, this.resourceType(resourceType));
  }

  @Post(':storeId/templates')
  createTemplate(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Body() dto: CreateResourceTemplateDto,
    @Query('resourceType') resourceType?: string,
  ) {
    return this.collectionTemplateService.createTemplate(storeId, req.user.userId, this.resourceType(resourceType), dto);
  }

  @Delete(':storeId/templates/:templateKey')
  deleteTemplate(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('templateKey') templateKey: string,
    @Query('resourceType') resourceType?: string,
  ) {
    return this.collectionTemplateService.deleteTemplate(storeId, req.user.userId, this.resourceType(resourceType), templateKey);
  }

  @Get(':storeId')
  get(@Req() req: any, @Param('storeId') storeId: string, @Query('resourceType') resourceType?: string, @Query('templateKey') templateKey?: string) {
    return this.collectionTemplateService.getForSeller(storeId, req.user.userId, this.resourceType(resourceType), templateKey);
  }

  @Get(':storeId/draft')
  getDraft(@Req() req: any, @Param('storeId') storeId: string, @Query('resourceType') resourceType?: string, @Query('templateKey') templateKey?: string) {
    return this.collectionTemplateService.getDraft(storeId, req.user.userId, this.resourceType(resourceType), templateKey);
  }

  @Patch(':storeId/sections')
  updateSections(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Body() dto: UpdateSectionsDto,
    @Query('resourceType') resourceType?: string,
    @Query('templateKey') templateKey?: string,
  ) {
    return this.collectionTemplateService.updateSections(storeId, req.user.userId, dto, this.resourceType(resourceType), templateKey);
  }

  @Patch(':storeId/publish')
  publish(@Req() req: any, @Param('storeId') storeId: string, @Query('resourceType') resourceType?: string, @Query('templateKey') templateKey?: string) {
    return this.collectionTemplateService.publish(storeId, req.user.userId, this.resourceType(resourceType), templateKey);
  }

  @Patch(':storeId/revert-draft')
  revertDraft(@Req() req: any, @Param('storeId') storeId: string, @Query('resourceType') resourceType?: string, @Query('templateKey') templateKey?: string) {
    return this.collectionTemplateService.revertDraft(storeId, req.user.userId, this.resourceType(resourceType), templateKey);
  }

  @Get(':storeId/versions')
  listVersions(@Req() req: any, @Param('storeId') storeId: string, @Query('resourceType') resourceType?: string, @Query('templateKey') templateKey?: string) {
    return this.collectionTemplateService.listVersions(storeId, req.user.userId, this.resourceType(resourceType), templateKey);
  }

  @Post(':storeId/versions/:versionId/restore')
  restoreVersion(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('versionId') versionId: string,
    @Query('resourceType') resourceType?: string,
    @Query('templateKey') templateKey?: string,
  ) {
    return this.collectionTemplateService.restoreVersion(storeId, req.user.userId, versionId, this.resourceType(resourceType), templateKey);
  }
}
