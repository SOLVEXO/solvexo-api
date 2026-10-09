/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AnalyticsQueryDto } from './analytics-query.dto';

export class SalesByQueryDto extends AnalyticsQueryDto {
  @ApiProperty({ enum: ['variant', 'discount', 'channel'], default: 'variant' })
  @IsOptional()
  @IsIn(['variant', 'discount', 'channel'])
  dimension?: string;
}

export class CohortsQueryDto extends AnalyticsQueryDto {
  @ApiProperty({ required: false, default: 12, minimum: 3, maximum: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(24)
  months?: number;
}
