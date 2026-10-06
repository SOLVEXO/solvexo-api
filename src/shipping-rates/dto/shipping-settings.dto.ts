/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';

export class ShippingPackageDto {
  /** Omit for a new package (server generates one). */
  @IsOptional() @IsString() @Matches(/^[\w-]{1,40}$/) id?: string;

  @IsString() @MinLength(1) @MaxLength(60) name: string;

  @IsNumber() @Min(0.1) @Max(1000) length: number;
  @IsNumber() @Min(0.1) @Max(1000) width: number;
  @IsNumber() @Min(0.1) @Max(1000) height: number;

  @IsIn(['cm', 'in']) unit: 'cm' | 'in';

  /** Weight of the empty package in kg. */
  @IsOptional() @IsNumber() @Min(0) @Max(1000) emptyWeight?: number;

  @IsOptional() @IsBoolean() isDefault?: boolean;
}

/** PUT api/store/:storeId/integrations/shipping/settings — replaces handling fee + saved packages. */
export class ShippingSettingsDto {
  @IsOptional() @IsIn(['flat', 'percent']) handlingFeeType?: 'flat' | 'percent' | null;

  @IsOptional() @IsNumber() @Min(0) @Max(100000) handlingFeeValue?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(25) @ValidateNested({ each: true }) @Type(() => ShippingPackageDto)
  packages?: ShippingPackageDto[];
}
