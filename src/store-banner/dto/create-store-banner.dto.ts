/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, IsDateString, IsUrl, Max, Min, MaxLength } from 'class-validator';
import { STORE_BANNER_TYPES, StoreBannerType, STORE_BANNER_LINK_TYPES, StoreBannerLinkType } from '../schemas/store-banner.schema';

export class CreateStoreBannerDto {
  @ApiProperty({ required: false, description: 'Separate image for phones (https URL)' })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  mobileImageUrl?: string | null;

  @ApiProperty({ enum: STORE_BANNER_TYPES, default: 'hero' })
  @IsOptional()
  @IsIn(STORE_BANNER_TYPES)
  type?: StoreBannerType;

  @ApiProperty({ required: false, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  heading?: string;

  @ApiProperty({ required: false, maxLength: 240 })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  subheading?: string;

  @ApiProperty({ required: false, enum: ['left', 'center', 'right'], default: 'left' })
  @IsOptional()
  @IsIn(['left', 'center', 'right'])
  contentAlignment?: 'left' | 'center' | 'right';

  @ApiProperty({ required: false, minimum: 0, maximum: 80, default: 35 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(80)
  overlayOpacity?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  ctaLabel?: string;

  @ApiProperty({ enum: STORE_BANNER_LINK_TYPES, default: 'external' })
  @IsOptional()
  @IsIn(STORE_BANNER_LINK_TYPES)
  linkType?: StoreBannerLinkType;

  @ApiProperty({ required: false, description: 'Product/category id, collection id, or an external URL depending on linkType' })
  @IsOptional()
  @IsString()
  linkTarget?: string;

  @ApiProperty({ required: false, example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  order?: number;

  @ApiProperty({ required: false, example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  priority?: number;

  @ApiProperty({ required: false, description: 'ISO date — leave empty to go live immediately' })
  @IsOptional()
  @IsDateString()
  startAt?: string;

  @ApiProperty({ required: false, description: 'ISO date — leave empty for no expiry' })
  @IsOptional()
  @IsDateString()
  endAt?: string;
}
