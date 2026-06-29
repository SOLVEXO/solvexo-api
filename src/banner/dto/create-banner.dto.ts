/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUrl, IsString, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateBannerDto {
  @ApiProperty({
    required: false,
    example: 'https://res.cloudinary.com/demo/image/upload/banner.jpg',
    description: 'Direct image URL — use this OR upload a file via /upload',
  })
  @IsOptional()
  @IsUrl({}, { message: 'bannerImage must be a valid URL' })
  bannerImage?: string;

  @ApiProperty({
    required: false,
    example: 'https://example.com/sale',
    description: 'URL to open when the banner is tapped',
  })
  @IsOptional()
  @IsUrl({}, { message: 'urlOnTap must be a valid URL' })
  urlOnTap?: string;

  @ApiProperty({ required: false, example: 0, description: 'Display order (0 = first)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  order?: number;
}
