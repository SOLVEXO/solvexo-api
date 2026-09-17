/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { CreateStoreBannerDto } from './create-store-banner.dto';

/** Same fields as `CreateStoreBannerDto`, for the "paste a URL" alternative
 *  to uploading a file — image-only (a Video banner still needs a real file
 *  upload, see `StoreBannerService.createFromUrl`). */
export class CreateStoreBannerFromUrlDto extends CreateStoreBannerDto {
  @ApiProperty({ description: 'A pasted image URL, re-hosted through Cloudinary server-side' })
  @IsString()
  @IsNotEmpty()
  imageUrl: string;
}
