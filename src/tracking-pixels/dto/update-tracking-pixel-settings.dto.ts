/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// Every field is optional; an empty string means "clear this platform's
// pixel" — TrackingPixelsService normalizes '' to null before saving, so
// the schema's "absent = that platform's script never loads" contract
// (see the schema's own doc comment) holds without needing `null` to pass
// class-validator here too.
//
// Strict per-provider formats: these ids are interpolated into a script on
// the live storefront (web `utils/trackingPixels.ts`), so only the exact
// id alphabet is accepted (surrounding whitespace is trimmed by the service).
export class UpdateTrackingPixelSettingsDto {
  @ApiProperty({ required: false, example: '1234567890123456' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^\s*(?:\d{5,20})?\s*$/, { message: 'Facebook Pixel ID must be 5-20 digits (or empty to clear)' })
  facebookPixelId?: string;

  @ApiProperty({ required: false, example: 'G-XXXXXXXXXX' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^\s*(?:(?:G|GT)-[A-Za-z0-9]{4,20})?\s*$/, { message: 'Google Analytics ID must look like G-XXXXXXXXXX (or empty to clear)' })
  googleAnalyticsId?: string;

  @ApiProperty({ required: false, example: 'AW-XXXXXXXXX' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^\s*(?:AW-\d{5,15})?\s*$/, { message: 'Google Ads ID must look like AW-123456789 (or empty to clear)' })
  googleAdsId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^\s*(?:[A-Za-z0-9_-]{4,64})?\s*$/, { message: 'Conversion label may only contain letters, digits, - and _ (or empty to clear)' })
  googleAdsConversionLabel?: string;

  @ApiProperty({ required: false, example: 'C4A1B2C3D4E5F6G7H8I9' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^\s*(?:[A-Za-z0-9]{10,30})?\s*$/, { message: 'TikTok Pixel ID must be 10-30 letters/digits (or empty to clear)' })
  tiktokPixelId?: string;
}
