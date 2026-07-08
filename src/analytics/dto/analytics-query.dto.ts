/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export const RANGE_PRESETS = ['7d', '30d', '90d', '6m', '12m', 'custom'] as const;

export class AnalyticsQueryDto {
  @ApiProperty({ description: 'Store to run analytics for — ownership is always verified server-side' })
  @IsString()
  @IsNotEmpty()
  storeId: string;

  @ApiProperty({ required: false, enum: RANGE_PRESETS, default: '30d' })
  @IsOptional()
  @IsIn(RANGE_PRESETS)
  range?: string;

  @ApiProperty({ required: false, description: 'Required together with `to` when range=custom' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({ required: false, description: 'Required together with `from` when range=custom' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  compareToPreviousPeriod?: boolean;
}
