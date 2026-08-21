/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ThemeCatalogService } from './theme-catalog.service';
import { CreateThemeDefinitionDto } from './dto/create-theme-definition.dto';
import { UpdateThemeDefinitionDto } from './dto/update-theme-definition.dto';
import { SetThemeStatusDto } from './dto/set-theme-status.dto';
import { SetThemeFeaturedDto } from './dto/set-theme-featured.dto';

@ApiTags('Admin Theme Catalog')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/theme-catalog')
export class AdminThemeCatalogController {
  constructor(private readonly themeCatalogService: ThemeCatalogService) {}

  @Get()
  list(@Query('category') category?: string, @Query('status') status?: string, @Query('search') search?: string) {
    return this.themeCatalogService.adminList({ category, status, search });
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.themeCatalogService.adminGetById(id);
  }

  @Post()
  create(@Body() dto: CreateThemeDefinitionDto) {
    return this.themeCatalogService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateThemeDefinitionDto) {
    return this.themeCatalogService.update(id, dto);
  }

  @Patch(':id/status')
  setStatus(@Param('id') id: string, @Body() dto: SetThemeStatusDto) {
    return this.themeCatalogService.setStatus(id, dto.status);
  }

  @Patch(':id/featured')
  setFeatured(@Param('id') id: string, @Body() dto: SetThemeFeaturedDto) {
    return this.themeCatalogService.setFeatured(id, dto.featured);
  }
}
