import {
    Controller,
    Get,
    Post,
    Delete,
    Param,
    Body,
    UploadedFile,
    UseInterceptors,
    UseGuards,
    HttpCode,
    HttpStatus,
    BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { BannersService } from './banner.service';
import { CreateBannerDto } from './dto/create-banner.dto';
import { createMulterOptions } from '../upload/multer.config';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ConfigService } from '@nestjs/config';

@ApiTags('Banners')
@Controller('api/banners')
export class BannersController {
    constructor(
        private readonly bannersService: BannersService,
        private readonly configService: ConfigService,
    ) { }

    // GET all banners — public
    @Get()
    findAll() {
        return this.bannersService.findAll();
    }

    // GET count — admin
    @Get('count')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    getCount() {
        return this.bannersService.getCount();
    }

    // POST via JSON URL  ← THIS IS WHAT YOU NEED
    @Post()
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.CREATED)
    createFromUrl(@Body() dto: CreateBannerDto) {
        return this.bannersService.createFromUrl(dto);
    }

    // POST via file upload
    @Post('upload')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.CREATED)
    @UseInterceptors(
        FileInterceptor('file', createMulterOptions(new ConfigService())),
    )
    async uploadBanner(@UploadedFile() file: Express.Multer.File) {
        if (!file) {
            throw new BadRequestException('Please provide a banner image file');
        }
        return this.bannersService.uploadBanner(file);
    }

    // DELETE banner — admin
    @Delete(':id')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    deleteBanner(@Param('id') id: string) {
        return this.bannersService.deleteBanner(id);
    }
}