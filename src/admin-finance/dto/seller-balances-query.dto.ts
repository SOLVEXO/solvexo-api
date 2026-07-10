/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const SELLER_BALANCE_SORTS = ['availableBalance', 'pendingBalance', 'totalRevenue', 'totalPayouts'] as const;
export const SORT_ORDERS = ['asc', 'desc'] as const;

export class SellerBalancesQueryDto {
  @ApiProperty({ required: false, description: 'Filter by seller name or email (case-insensitive substring)' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ required: false, enum: SELLER_BALANCE_SORTS, default: 'availableBalance' })
  @IsOptional()
  @IsIn(SELLER_BALANCE_SORTS)
  sort?: string;

  @ApiProperty({ required: false, enum: SORT_ORDERS, default: 'desc' })
  @IsOptional()
  @IsIn(SORT_ORDERS)
  order?: string;

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
}
