/* eslint-disable prettier/prettier */
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { SITE_RANGES, type SiteRange } from './site-analytics.util';

export class SiteRangeDto {
  @IsOptional()
  @IsIn(SITE_RANGES)
  range?: SiteRange;
}

export class SiteAnalyticsSettingsDto {
  /** Empty string clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  measurementId?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
