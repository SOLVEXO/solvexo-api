/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { AdminAnalyticsQueryDto } from '../../admin-analytics/dto/admin-analytics-query.dto';

export const ADMIN_FINANCE_EXPORT_FORMATS = ['pdf', 'csv'] as const;
export const ADMIN_FINANCE_EXPORT_SECTIONS = ['transactions', 'payouts', 'sellers', 'refunds', 'tax', 'settlement'] as const;

export class AdminFinanceExportQueryDto extends AdminAnalyticsQueryDto {
  @ApiProperty({ enum: ADMIN_FINANCE_EXPORT_FORMATS })
  @IsIn(ADMIN_FINANCE_EXPORT_FORMATS)
  format: string;

  @ApiProperty({ required: false, enum: ADMIN_FINANCE_EXPORT_SECTIONS, description: 'Required when format=csv' })
  @IsOptional()
  @IsIn(ADMIN_FINANCE_EXPORT_SECTIONS)
  section?: string;
}
