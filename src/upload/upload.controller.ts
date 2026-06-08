/* eslint-disable prettier/prettier */
import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { UploadService } from './upload.service';
import { ConfigService } from '@nestjs/config';
import { createMulterOptions } from './multer.config';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('Upload')
@Controller('api/upload')
@UseGuards(JwtAuthGuard)    // ✅ Fix 1: Protect all upload routes
@ApiBearerAuth()
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly configService: ConfigService,  // ✅ Properly injected
  ) { }

  @Post('image')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Upload image to Cloudinary' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Image file (jpg, jpeg, png, webp — max 5MB)',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Image uploaded successfully',
    schema: {
      example: {
        success: true,
        message: 'Image uploaded successfully',
        data: {
          url: 'https://res.cloudinary.com/yourcloud/image/upload/v123/uploads/photo-123456.jpg',
          publicId: 'uploads/photo-123456',
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'No file / Invalid type / File too large' })
  @ApiResponse({ status: 401, description: 'Unauthorized - JWT token required' })
  @UseInterceptors(
    FileInterceptor('file', createMulterOptions(new ConfigService())),
    // ⚠️ NOTE: new ConfigService() reads directly from process.env which is
    // loaded by ConfigModule.forRoot() in app.module.ts — this works correctly
  )
  async uploadImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded. Please select an image.');
    }

    const result = await this.uploadService.uploadFile(file);

    return {
      success: true,
      message: 'Image uploaded successfully',
      data: result,
    };
  }
}