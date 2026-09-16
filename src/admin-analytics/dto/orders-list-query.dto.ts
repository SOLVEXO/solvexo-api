/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AdminAnalyticsQueryDto } from './admin-analytics-query.dto';

// The one real rollup-status enum — see order-status.util.ts's own doc
// comment on why this is the single source of truth, never re-derived here.
export const ORDER_LIST_STATUSES = [
  'pending', 'processing', 'shipped', 'delivered', 'completed',
  'cancelled', 'refunded', 'partially_cancelled', 'partially_refunded', 'partially_shipped',
] as const;

/** Phase 7 — real Mongo-side (skip/limit) pagination, unlike the
 *  Sellers/Products tabs' in-memory `.slice()` pagination: an admin-wide
 *  order list can be far larger than the seller/product tables, so it must
 *  never fetch the full unpaginated set into memory just to page through it. */
export class OrdersListQueryDto extends AdminAnalyticsQueryDto {
  @ApiProperty({ required: false, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiProperty({ required: false, default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiProperty({ required: false, enum: ORDER_LIST_STATUSES, description: 'Optional — filter to one real rollup status' })
  @IsOptional()
  @IsIn(ORDER_LIST_STATUSES)
  status?: string;
}
