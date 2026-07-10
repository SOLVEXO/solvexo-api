/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsOptional } from 'class-validator';

export const RANGE_PRESETS = ['7d', '30d', '90d', '6m', '12m', 'custom'] as const;

/**
 * Date-range query fields shared by every analytics surface (seller + admin).
 * Seller analytics (`AnalyticsQueryDto`) adds a required `storeId` on top of this;
 * admin analytics (`AdminAnalyticsQueryDto`) stays platform-wide and adds only
 * optional drill-down filters.
 */
export class BaseAnalyticsQueryDto {
  @ApiProperty({ required: false, enum: RANGE_PRESETS, default: '30d' })
  @IsOptional()
  @IsIn(RANGE_PRESETS)
  range?: string;

  @ApiProperty({ required: false, description: 'Required together with `to` when range=custom' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({ required: false, description: 'Required together with `from` when range=custom' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  compareToPreviousPeriod?: boolean;
}
