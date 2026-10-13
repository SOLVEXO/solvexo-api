/* eslint-disable prettier/prettier */
import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsOptional, IsUrl, MaxLength } from 'class-validator';
import { CreateStoreBannerDto } from './create-store-banner.dto';

export class UpdateStoreBannerDto extends PartialType(CreateStoreBannerDto) {
  @ApiProperty({ required: false, description: 'Replace the banner image (https URL)' })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  imageUrl?: string;
}
