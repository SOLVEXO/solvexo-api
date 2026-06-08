/* eslint-disable prettier/prettier */
import { v2 as cloudinary } from 'cloudinary';
import { ConfigService } from '@nestjs/config';

export const configureCloudinary = (configService: ConfigService) => {
  const cloudName = configService.get<string>('CLOUDINARY_CLOUD_NAME');
  const apiKey = configService.get<string>('CLOUDINARY_API_KEY');
  const apiSecret = configService.get<string>('CLOUDINARY_API_SECRET');

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      '❌ Cloudinary credentials missing! Check your .env file:\n' +
      `  CLOUDINARY_CLOUD_NAME: ${cloudName ? '✅' : '❌ Missing'}\n` +
      `  CLOUDINARY_API_KEY: ${apiKey ? '✅' : '❌ Missing'}\n` +
      `  CLOUDINARY_API_SECRET: ${apiSecret ? '✅' : '❌ Missing'}`,
    );
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
  });

  console.log('✅ Cloudinary configured successfully');
  return cloudinary;
};