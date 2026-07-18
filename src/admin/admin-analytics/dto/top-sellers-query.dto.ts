/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AdminAnalyticsQueryDto } from './admin-analytics-query.dto';

export const SELLER_SORTS = ['revenue', 'orders'] as const;
export const SORT_ORDERS = ['asc', 'desc'] as const;

/**
 * Backs both "Top Sellers" and "Lowest Performing Sellers" — the same ranked-list
 * query, just flipped via `order`. Avoids a duplicate endpoint/aggregation for what
 * is otherwise identical logic sorted the other way.
 */
export class TopSellersQueryDto extends AdminAnalyticsQueryDto {
  @ApiProperty({ required: false, default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiProperty({ required: false, enum: SELLER_SORTS, default: 'revenue' })
  @IsOptional()
  @IsIn(SELLER_SORTS)
  sort?: string;

  @ApiProperty({ required: false, enum: SORT_ORDERS, default: 'desc', description: '`asc` surfaces the lowest performers first' })
  @IsOptional()
  @IsIn(SORT_ORDERS)
  order?: string;
}
