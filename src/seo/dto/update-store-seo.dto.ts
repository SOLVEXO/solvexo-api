/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { UpdateSeoMetaDto } from './update-seo-meta.dto';

/** Store-only SEO fields on top of the shared meta shape (products and pages have no verification code). */
export class UpdateStoreSeoDto extends UpdateSeoMetaDto {
  @ApiProperty({ required: false, description: 'Google site-verification meta tag or its content value; blank removes it.' })
  @IsOptional() @IsString() @MaxLength(600)
  googleSiteVerification?: string;
}
