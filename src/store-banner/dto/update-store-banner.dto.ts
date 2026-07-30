/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { PartialType } from '@nestjs/swagger';
import { CreateStoreBannerDto } from './create-store-banner.dto';

export class UpdateStoreBannerDto extends PartialType(CreateStoreBannerDto) {
  @ApiProperty({ required: false })
  mobileImageUrl?: string;
}
