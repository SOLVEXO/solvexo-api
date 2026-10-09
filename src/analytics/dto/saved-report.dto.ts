/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { RANGE_PRESETS } from './base-analytics-query.dto';
import { EXPORT_FORMATS, EXPORT_SECTIONS } from './export-query.dto';

export class SavedReportConfigDto {
  @IsOptional() @IsIn(RANGE_PRESETS) range?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsBoolean() compareToPreviousPeriod?: boolean;
  @IsOptional() @IsIn(EXPORT_FORMATS) format?: string;
  @IsOptional() @IsIn(EXPORT_SECTIONS) section?: string;
}

export class CreateSavedReportDto {
  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiProperty({ type: SavedReportConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SavedReportConfigDto)
  config?: SavedReportConfigDto;
}
