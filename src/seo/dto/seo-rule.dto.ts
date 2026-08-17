/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsBoolean, IsObject } from 'class-validator';

export const SEO_RULE_CODES = [
  'title_length', 'description_length', 'missing_alt_text', 'thin_content',
  'duplicate_meta', 'missing_canonical', 'broken_internal_link', 'missing_schema',
] as const;

export class UpsertSeoRuleDto {
  @ApiProperty({ enum: SEO_RULE_CODES })
  @IsIn(SEO_RULE_CODES)
  code: string;

  @ApiProperty({ required: false, default: true })
  @IsOptional() @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ required: false, example: { max: 60 } })
  @IsOptional() @IsObject()
  thresholds?: Record<string, number>;

  @ApiProperty({ required: false, enum: ['info', 'warning', 'error'] })
  @IsOptional() @IsIn(['info', 'warning', 'error'])
  severity?: string;
}
