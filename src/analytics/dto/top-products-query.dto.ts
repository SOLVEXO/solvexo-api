/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AnalyticsQueryDto } from './analytics-query.dto';

// 'profit_margin' is intentionally NOT offered — there is no cost/COGS field
// on Product or ProductVariant in this codebase, so a margin ranking would
// have to fabricate cost data. See the analytics report for this gap.
export const TOP_PRODUCTS_SORTS = ['revenue', 'units_sold'] as const;

export class TopProductsQueryDto extends AnalyticsQueryDto {
  @ApiProperty({ required: false, default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiProperty({ required: false, enum: TOP_PRODUCTS_SORTS, default: 'revenue' })
  @IsOptional()
  @IsIn(TOP_PRODUCTS_SORTS)
  sort?: string;
}
