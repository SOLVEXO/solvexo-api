/* eslint-disable prettier/prettier */
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import { configureCloudinary } from './cloudinary.config';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import * as path from 'path';

const ALLOWED_MIME_TYPES = /\/(jpg|jpeg|png|webp)$/;
const MAX_FILE_SIZE_MB = 5;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

export const createMulterOptions = (configService: ConfigService) => {
  // ✅ Fix 1: Configure cloudinary with proper credentials
  configureCloudinary(configService);

  const storage = new CloudinaryStorage({
    cloudinary,
    params: async (_req: Express.Request, file: Express.Multer.File) => {
      // ✅ Fix 2: Add unique suffix to prevent overwriting existing files
      const nameWithoutExt = path.parse(file.originalname).name
        .replace(/[^a-zA-Z0-9]/g, '_') // sanitize filename
        .toLowerCase();
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;

      return {
        folder: 'uploads',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        // ✅ Fix 3: Unique public_id so files don't overwrite each other
        public_id: `${nameWithoutExt}-${uniqueSuffix}`,
        // ✅ Fix 4: Auto-optimize images on Cloudinary side
        transformation: [
          { width: 1024, height: 1024, crop: 'limit' },
          { quality: 'auto' },
          { fetch_format: 'auto' },
        ],
      };
    },
  });

  return {
    storage,
    // ✅ Fix 5: Enforce file size limit
    limits: {
      fileSize: MAX_FILE_SIZE_BYTES,
    },
    // ✅ Fix 6: Validate MIME type before upload
    fileFilter: (
      _req: Express.Request,
      file: Express.Multer.File,
      callback: (error: Error | null, acceptFile: boolean) => void,
    ) => {
      if (!file.mimetype.match(ALLOWED_MIME_TYPES)) {
        return callback(
          new BadRequestException(
            `Invalid file type "${file.mimetype}". Only jpg, jpeg, png, webp are allowed.`,
          ),
          false,
        );
      }
      callback(null, true);
    },
  };
};