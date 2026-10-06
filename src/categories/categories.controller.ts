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

@Controller('api/categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Post('add-category')
  async addCategory(
    @Req() req: any,
    @Body() createCategoryDto: CreateCategoryDto,
  ) {
    const { userId, role } = req.user;
    return this.categoriesService.addCategory(userId, role, createCategoryDto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('store/:storeId/import-template')
  importTemplate() {
    return buildTemplatePayload('categories-import-template.csv', CATEGORY_IMPORT_COLUMNS);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('store/:storeId/import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  importCategories(@Req() req: any, @Param('storeId') storeId: string, @UploadedFile() file: any) {
    return this.categoriesService.importCsv(req.user.userId, storeId, readUploadedCsv(file));
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
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Put('category/:id')
  async updateCategory(
    @Req() req: any,
    @Param('id') id: string,
    @Query('storeId') storeId: string,
    @Body() updateCategoryDto: UpdateCategoryDto,
  ) {
    const { userId } = req.user;
    return this.categoriesService.updateCategory(userId, storeId, id, updateCategoryDto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete('category/:id')
  async deleteCategory(
    @Req() req: any,
    @Param('id') id: string,
    @Query('storeId') storeId: string,
  ) {
    const { userId } = req.user;
    return this.categoriesService.deleteCategory(userId, storeId, id);
  }
}
