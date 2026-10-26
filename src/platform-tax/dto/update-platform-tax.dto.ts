/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PLATFORM_TAX_AUTHORITIES } from '../platform-tax.util';

export class PlatformTaxRateDto {
  @IsOptional() @IsString() @MaxLength(64) id?: string;
  @IsString() @Matches(/^[A-Za-z]{2}$/, { message: 'country must be a 2-letter ISO code' }) country: string;
  @IsString() @MaxLength(40) label: string;
  @IsNumber() @Min(0) @Max(100) ratePercent: number;
  @IsIn(['draft', 'confirmed']) status: 'draft' | 'confirmed';
  @IsOptional() @IsDateString() effectiveFrom?: string | null;
}

export class UpdatePlatformTaxDto {
  @IsOptional() @IsString() @MaxLength(120) legalName?: string;
  @IsOptional() @IsString() @MaxLength(30) ntn?: string;
  @IsOptional() @IsString() @MaxLength(30) strn?: string;
  @IsOptional() @IsIn(PLATFORM_TAX_AUTHORITIES) authority?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => PlatformTaxRateDto)
  rates?: PlatformTaxRateDto[];
}

export class ApplyPlatformTaxDto {
  @IsOptional() @IsBoolean() dryRun?: boolean;
}
