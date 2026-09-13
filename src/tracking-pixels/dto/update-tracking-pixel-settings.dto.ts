/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

// Every field is optional; an empty string means "clear this platform's
// pixel" — TrackingPixelsService normalizes '' to null before saving, so
// the schema's "absent = that platform's script never loads" contract
// (see the schema's own doc comment) holds without needing `null` to pass
// class-validator here too.
export class UpdateTrackingPixelSettingsDto {
  @ApiProperty({ required: false, example: '1234567890123456' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  facebookPixelId?: string;

  @ApiProperty({ required: false, example: 'G-XXXXXXXXXX' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  googleAnalyticsId?: string;

  @ApiProperty({ required: false, example: 'AW-XXXXXXXXX' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  googleAdsId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  googleAdsConversionLabel?: string;

  @ApiProperty({ required: false, example: 'C4A1B2C3D4E5F6G7H8I9' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tiktokPixelId?: string;
}
