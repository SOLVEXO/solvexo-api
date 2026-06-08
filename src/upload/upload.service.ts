/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException } from '@nestjs/common';

export interface UploadResult {
  url: string;
  publicId: string;
  width?: number;
  height?: number;
  format?: string;
  size?: number;
}

@Injectable()
export class UploadService {
  async uploadFile(file: Express.Multer.File): Promise<UploadResult> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // ✅ Fix: multer-storage-cloudinary puts the URL in file.path
    // and public_id in file.filename
    const url = (file as any).path || '';
    const publicId = (file as any).filename || '';

    if (!url) {
      console.error('❌ Cloudinary did not return a URL. File object:', JSON.stringify(file, null, 2));
      throw new BadRequestException('Upload failed: Cloudinary did not return a URL');
    }

    console.log(`✅ File uploaded successfully → ${url}`);

    return {
      url,
      publicId,
      format: (file as any).format,
      width: (file as any).width,
      height: (file as any).height,
      size: file.size,
    };
  }
}