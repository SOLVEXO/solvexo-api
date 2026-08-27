/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Delete, Param, Body, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { CollectionsService } from './collections.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { UpdateCollectionProductsDto } from './dto/update-collection-products.dto';

@ApiTags('Collections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/collections')
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Post(':storeId')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateCollectionDto) {
    return this.collectionsService.create(storeId, req.user.userId, dto);
  }

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.collectionsService.listForSeller(storeId, req.user.userId);
  }

  @Get(':storeId/:collectionId')
  get(@Req() req: any, @Param('storeId') storeId: string, @Param('collectionId') collectionId: string) {
    return this.collectionsService.getForSeller(storeId, req.user.userId, collectionId);
  }

  @Patch(':storeId/:collectionId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('collectionId') collectionId: string, @Body() dto: UpdateCollectionDto) {
    return this.collectionsService.update(storeId, req.user.userId, collectionId, dto);
  }

  @Patch(':storeId/:collectionId/products')
  updateProducts(@Req() req: any, @Param('storeId') storeId: string, @Param('collectionId') collectionId: string, @Body() dto: UpdateCollectionProductsDto) {
    return this.collectionsService.updateProducts(storeId, req.user.userId, collectionId, dto);
  }

  @Delete(':storeId/:collectionId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('collectionId') collectionId: string) {
    return this.collectionsService.delete(storeId, req.user.userId, collectionId);
  }
}
