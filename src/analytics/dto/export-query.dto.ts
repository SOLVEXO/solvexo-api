/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { AnalyticsQueryDto } from './analytics-query.dto';

export const EXPORT_FORMATS = ['pdf', 'csv'] as const;
export const EXPORT_SECTIONS = ['revenue', 'orders', 'products', 'customers'] as const;

export class ExportQueryDto extends AnalyticsQueryDto {
  @ApiProperty({ enum: EXPORT_FORMATS })
  @IsIn(EXPORT_FORMATS)
  format: string;

  @ApiProperty({ required: false, enum: EXPORT_SECTIONS, description: 'Required when format=csv' })
  @IsOptional()
  @IsIn(EXPORT_SECTIONS)
  section?: string;
}
