import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Req,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { buildTemplatePayload, readUploadedCsv } from '../common/bulk-import/bulk-import.util';
import { CATEGORY_IMPORT_COLUMNS } from './categories-bulk-import';

import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { AuthGuard } from '@nestjs/passport';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingRole, actingSellerId } from '../common/acting-seller-id.util';
@Controller('api/categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('categories.manage')
  @Post('add-category')
  async addCategory(
    @Req() req: any,
    @Body() createCategoryDto: CreateCategoryDto,
  ) {
    const role = actingRole(req.user);
    const userId = actingSellerId(req.user);
    return this.categoriesService.addCategory(userId, role, createCategoryDto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('categories.manage')
  @Get('store/:storeId/import-template')
  importTemplate() {
    return buildTemplatePayload('categories-import-template.csv', CATEGORY_IMPORT_COLUMNS);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('categories.manage')
  @Post('store/:storeId/import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  importCategories(@Req() req: any, @Param('storeId') storeId: string, @UploadedFile() file: any) {
    return this.categoriesService.importCsv(actingSellerId(req.user), storeId, readUploadedCsv(file));
  }

  // Seller's own view — includes hidden categories (the public `category-tree`
  // below never does). Declared before any `:param` GET routes.
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('categories.manage')
  @Get('store/:storeId/category-tree')
  async getStoreCategoryTreeForSeller(@Req() req: any, @Param('storeId') storeId: string) {
    return this.categoriesService.getStoreCategoryTreeForSeller(actingSellerId(req.user), storeId);
  }

  @Get('category-tree')
  async getCategoryTree(@Query('id') id?: string, @Query('storeId') storeId?: string) {
    return this.categoriesService.getCategoryTreeNested(id, storeId);
  }

  @Get('category/:id')
  async getCategoryById(@Param('id') id: string, @Query('storeId') storeId?: string) {
    return this.categoriesService.getCategoryWithChildren(id, storeId);
  }

  // Store-owned categories only (a seller's own privately-created tree, see
  // CategoriesService.addCategory) — the legacy/global admin taxonomy has no
  // rename/delete path here, unchanged.
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('categories.manage')
  @Put('category/:id')
  async updateCategory(
    @Req() req: any,
    @Param('id') id: string,
    @Query('storeId') storeId: string,
    @Body() updateCategoryDto: UpdateCategoryDto,
  ) {
    const userId = actingSellerId(req.user);
    return this.categoriesService.updateCategory(userId, storeId, id, updateCategoryDto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('categories.manage')
  @Delete('category/:id')
  async deleteCategory(
    @Req() req: any,
    @Param('id') id: string,
    @Query('storeId') storeId: string,
  ) {
    const userId = actingSellerId(req.user);
    return this.categoriesService.deleteCategory(userId, storeId, id);
  }
}
