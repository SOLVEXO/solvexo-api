/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { ATTRIBUTION_DIMENSIONS, ATTRIBUTION_MODELS } from '../utils/attribution.util';
import { BaseAnalyticsQueryDto, RANGE_PRESETS } from './base-analytics-query.dto';

export { RANGE_PRESETS };

/** Growth → Attribution: which model credits the order, and what the rows are (channel / source / campaign). */
export class AttributionQueryDto extends BaseAnalyticsQueryDto {
  @ApiProperty({ required: true, description: 'Store to report on (ownership is verified server-side)' })
  @IsString()
  storeId: string;

  @ApiProperty({ required: false, enum: ATTRIBUTION_MODELS as unknown as string[], default: 'last_non_direct' })
  @IsOptional()
  @IsIn(ATTRIBUTION_MODELS as unknown as string[])
  model?: string;

  @ApiProperty({ required: false, enum: ATTRIBUTION_DIMENSIONS as unknown as string[], default: 'channel' })
  @IsOptional()
  @IsIn(ATTRIBUTION_DIMENSIONS as unknown as string[])
  by?: string;
}

export class AnalyticsQueryDto extends BaseAnalyticsQueryDto {
  @ApiProperty({
    required: false,
    description: 'Store to run analytics for (ownership is always verified server-side). Omit for the cross-store seller dashboard — aggregates across every store the seller owns instead of one.',
  })
  @IsOptional()
  @IsString()
  storeId?: string;
}
