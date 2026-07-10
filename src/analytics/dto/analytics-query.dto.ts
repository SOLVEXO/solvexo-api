/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { BaseAnalyticsQueryDto, RANGE_PRESETS } from './base-analytics-query.dto';

export { RANGE_PRESETS };

export class AnalyticsQueryDto extends BaseAnalyticsQueryDto {
  @ApiProperty({ description: 'Store to run analytics for — ownership is always verified server-side' })
  @IsString()
  @IsNotEmpty()
  storeId: string;
}
