/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { BaseAnalyticsQueryDto, RANGE_PRESETS } from './base-analytics-query.dto';

export { RANGE_PRESETS };

export class AnalyticsQueryDto extends BaseAnalyticsQueryDto {
  @ApiProperty({
    required: false,
    description: 'Store to run analytics for (ownership is always verified server-side). Omit for the cross-store seller dashboard — aggregates across every store the seller owns instead of one.',
  })
  @IsOptional()
  @IsString()
  storeId?: string;
}
