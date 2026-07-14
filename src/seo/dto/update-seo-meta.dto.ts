/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsIn, IsArray, MaxLength } from 'class-validator';

/**
 * Shared shape for editing the embedded `SeoMeta`/`StoreSeo` sub-document —
 * reused by admin (category override) and seller (product/store/page)
 * controllers alike, mirroring the schema shape in seo/schemas/seo-meta.schema.ts.
 */
export class UpdateSeoMetaDto {
  @ApiProperty({ required: false, maxLength: 70 })
  @IsOptional() @IsString() @MaxLength(70)
  metaTitle?: string;

  @ApiProperty({ required: false, maxLength: 320 })
  @IsOptional() @IsString() @MaxLength(320)
  metaDescription?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString()
  ogImage?: string;

  @ApiProperty({ required: false, maxLength: 70 })
  @IsOptional() @IsString() @MaxLength(70)
  ogTitle?: string;

  @ApiProperty({ required: false, maxLength: 320 })
  @IsOptional() @IsString() @MaxLength(320)
  ogDescription?: string;

  @ApiProperty({ required: false, enum: ['summary', 'summary_large_image'] })
  @IsOptional() @IsIn(['summary', 'summary_large_image'])
  twitterCard?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString()
  canonicalUrlOverride?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsBoolean()
  noindex?: boolean;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional() @IsArray()
  keywords?: string[];
}
