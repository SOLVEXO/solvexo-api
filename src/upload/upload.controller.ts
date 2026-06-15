/* eslint-disable prettier/prettier */
import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UploadService } from './upload.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('api/upload')
@UseGuards(JwtAuthGuard)
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  // ── PUBLIC file (images, videos) — koi bhi logged-in user ──
  @Post('file')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  }))
  async uploadFile(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    const result = await this.uploadService.uploadFile(file);
    return { success: true, message: 'File uploaded successfully', data: result };
  }

  // ── PRIVATE file (digital products for sale) — sirf seller ──
  @Post('private-file')
  @UseGuards(RolesGuard)
  @Roles('seller')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  }))
  async uploadPrivateFile(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    const result = await this.uploadService.uploadPrivateFile(file);
    return {
      success: true,
      message: 'Private file uploaded successfully',
      data: result,
      note: 'Save publicId in your product — URL is not accessible directly',
    };
  }
}
