import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    Req,
    Query
} from '@nestjs/common';

import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { AuthGuard } from '@nestjs/passport';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator'
import { RolesGuard } from '../auth/guards/roles.guard'; 

@Controller('api/categories')
export class CategoriesController {
    constructor(private readonly categoriesService: CategoriesService) { }

   @UseGuards(JwtAuthGuard, RolesGuard)
 @Roles( 'seller', 'admin')
    @Post('add-category')
async addCategory( @Req() req: any , @Body() createCategoryDto: CreateCategoryDto) {
    const {sellerId , role} = req.user
    console.log(sellerId, role)
  return this.categoriesService.addCategory(role, sellerId, createCategoryDto);
}

@Get('category-tree')
async getCategoryTree(@Query('id') id?: string) {
  return this.categoriesService.getCategoryTreeNested(id);
}

@Get('category/:id')
async getCategoryById(@Param('id') id: string) {
  return this.categoriesService.getCategoryWithChildren(id);
}




}