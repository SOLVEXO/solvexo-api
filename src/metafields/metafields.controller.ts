/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { MetafieldsService } from './metafields.service';
import { CreateDefinitionDto } from './dto/create-definition.dto';
import { UpdateDefinitionDto } from './dto/update-definition.dto';
import { SetValuesDto } from './dto/set-values.dto';
import type { MetafieldOwnerResource } from './schemas/metafield-definition.schema';

// Grouped with Metaobjects under the same `content.metaobjects.manage`
// permission — Solvexo has no separate route-level way to distinguish
// "metafield definitions" from "metaobject definitions" access, and
// Shopify's own permission model treats both as one "Content" scope.
@ApiTags('Metafields (seller)')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('content.metaobjects.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/metafields')
export class MetafieldsController {
  constructor(private readonly metafieldsService: MetafieldsService) {}

  @Get(':storeId/definitions')
  listDefinitions(@Req() req: any, @Param('storeId') storeId: string, @Query('ownerResource') ownerResource?: MetafieldOwnerResource) {
    return this.metafieldsService.listDefinitions(storeId, actingSellerId(req.user), ownerResource);
  }

  @Post(':storeId/definitions')
  createDefinition(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateDefinitionDto) {
    return this.metafieldsService.createDefinition(storeId, actingSellerId(req.user), dto);
  }

  @Patch(':storeId/definitions/:definitionId')
  updateDefinition(@Req() req: any, @Param('storeId') storeId: string, @Param('definitionId') definitionId: string, @Body() dto: UpdateDefinitionDto) {
    return this.metafieldsService.updateDefinition(storeId, actingSellerId(req.user), definitionId, dto);
  }

  @Delete(':storeId/definitions/:definitionId')
  deleteDefinition(@Req() req: any, @Param('storeId') storeId: string, @Param('definitionId') definitionId: string) {
    return this.metafieldsService.deleteDefinition(storeId, actingSellerId(req.user), definitionId);
  }

  @Get(':storeId/values/:ownerResource/:ownerId')
  getValues(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('ownerResource') ownerResource: MetafieldOwnerResource,
    @Param('ownerId') ownerId: string,
  ) {
    return this.metafieldsService.getValues(storeId, actingSellerId(req.user), ownerResource, ownerId);
  }

  @Put(':storeId/values/:ownerResource/:ownerId')
  setValues(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('ownerResource') ownerResource: MetafieldOwnerResource,
    @Param('ownerId') ownerId: string,
    @Body() dto: SetValuesDto,
  ) {
    return this.metafieldsService.setValues(storeId, actingSellerId(req.user), ownerResource, ownerId, dto);
  }
}
