/* eslint-disable prettier/prettier */
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/** Optional filters layered on top of a campaign's `audience` — all are ANDed.
 *  Order-based filters only ever match subscribers who are also customers. */
export class CampaignSegmentDto {
  @ApiPropertyOptional({ description: 'At least this many orders from this store' })
  @IsOptional() @IsInt() @Min(0) @Max(100_000)
  minOrders?: number;

  @ApiPropertyOptional({ description: 'Total spent at this store is at least this (store currency)' })
  @IsOptional() @IsNumber() @Min(0)
  minTotalSpent?: number;

  @ApiPropertyOptional({ description: 'Last order was within this many days' })
  @IsOptional() @IsInt() @Min(1) @Max(3650)
  orderedWithinDays?: number;

  @ApiPropertyOptional({ description: 'No order in at least this many days' })
  @IsOptional() @IsInt() @Min(1) @Max(3650)
  notOrderedWithinDays?: number;

  @ApiPropertyOptional({ description: 'Customer has any of these tags (Customers → tags)' })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true })
  tags?: string[];
}

export class AudiencePreviewDto {
  @IsIn(['all', 'buyers', 'abandoned'])
  audience: 'all' | 'buyers' | 'abandoned';

  @IsOptional() @ValidateNested() @Type(() => CampaignSegmentDto)
  segment?: CampaignSegmentDto | null;
}

export class SendTestEmailDto {
  @ApiPropertyOptional({ description: "Defaults to the seller's own account email" })
  @IsOptional() @IsEmail()
  email?: string;
}
