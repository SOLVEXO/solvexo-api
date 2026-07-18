/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUrl, IsBoolean, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateBannerDto {
  @ApiProperty({ required: false, example: 'https://res.cloudinary.com/demo/image/upload/banner.jpg' })
  @IsOptional()
  @IsUrl({}, { message: 'bannerImage must be a valid URL' })
  bannerImage?: string;

  @ApiProperty({ required: false, example: 'https://example.com/sale' })
  @IsOptional()
  @IsUrl({}, { message: 'urlOnTap must be a valid URL' })
  urlOnTap?: string;

  @ApiProperty({ required: false, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  order?: number;

  @ApiProperty({ required: false, example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
