/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { AdminAnalyticsQueryDto } from './admin-analytics-query.dto';

export const EXPORT_FORMATS = ['pdf', 'csv'] as const;
// Must list every section the service exports (payments + platform were missing -> 400 from the UI).
export const EXPORT_SECTIONS = ['revenue', 'orders', 'sellers', 'products', 'customers', 'payments', 'platform'] as const;

export class AdminExportQueryDto extends AdminAnalyticsQueryDto {
  @ApiProperty({ enum: EXPORT_FORMATS })
  @IsIn(EXPORT_FORMATS)
  format: string;

  @ApiProperty({ required: false, enum: EXPORT_SECTIONS, description: 'Required when format=csv' })
  @IsOptional()
  @IsIn(EXPORT_SECTIONS)
  section?: string;
}
