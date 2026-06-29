/* eslint-disable prettier/prettier */
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { BannersService } from './banner.service';
import { CreateBannerDto } from './dto/create-banner.dto';
import { UpdateBannerDto } from './dto/update-banner.dto';
import { createMulterOptions } from '../upload/multer.config';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
@ApiTags('Banners')
@Controller('api/banners')
export class BannersController {
  constructor(private readonly bannersService: BannersService) {}

  // GET all banners — public
  @Get()
  findAll() {
    return this.bannersService.findAll();
  }

  // GET banner count — admin only
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Get('count')
  getCount() {
    return this.bannersService.getCount();
  }

  // POST via JSON URL — admin only
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  createFromUrl(@Body() dto: CreateBannerDto) {
    return this.bannersService.createFromUrl(dto);
  }

  // POST via file upload — admin only
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', createMulterOptions(new ConfigService())))
  async uploadBanner(
    @UploadedFile() file: Express.Multer.File,
    @Query('urlOnTap') urlOnTap?: string,
  ) {
    if (!file) throw new BadRequestException('Please provide a banner image file');
    return this.bannersService.uploadBanner(file, urlOnTap);
  }

  // PATCH edit banner — admin only
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Patch(':id')
  updateBanner(@Param('id') id: string, @Body() dto: UpdateBannerDto) {
    return this.bannersService.updateBanner(id, dto);
  }

  // DELETE banner — admin only
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Delete(':id')
  deleteBanner(@Param('id') id: string) {
    return this.bannersService.deleteBanner(id);
  }
}
