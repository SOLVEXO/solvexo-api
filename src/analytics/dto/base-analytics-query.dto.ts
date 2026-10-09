/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
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

  // Query strings arrive as text: "false" must stay false (a plain Boolean cast turned it into true).
  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  compareToPreviousPeriod?: boolean;

  @ApiProperty({ required: false, enum: ['day', 'week', 'month'], description: 'Chart bucket override (auto by range length when omitted)' })
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  granularity?: string;

  @ApiProperty({ required: false, enum: ['previous_period', 'previous_year'], default: 'previous_period' })
  @IsOptional()
  @IsIn(['previous_period', 'previous_year'])
  compareTo?: string;
}
