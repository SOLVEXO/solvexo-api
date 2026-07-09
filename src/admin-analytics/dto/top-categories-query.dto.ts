/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AdminAnalyticsQueryDto } from './admin-analytics-query.dto';

export const TOP_CATEGORIES_SORTS = ['revenue', 'units_sold'] as const;

export class TopCategoriesQueryDto extends AdminAnalyticsQueryDto {
  @ApiProperty({ required: false, default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiProperty({ required: false, enum: TOP_CATEGORIES_SORTS, default: 'revenue' })
  @IsOptional()
  @IsIn(TOP_CATEGORIES_SORTS)
  sort?: string;
}
