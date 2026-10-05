/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsMongoId, IsNumber, IsOptional, IsString, Max, MaxLength,
  Min, ValidateNested,
} from 'class-validator';

/** Which products a bulk action applies to: an explicit selection, or "all N products matching the current filter"
 *  (Shopify's "Select all N+ products"). */
export class BulkFilterDto {
  @IsOptional() @IsString() @MaxLength(20) status?: string;
  @IsOptional() @IsString() @MaxLength(20) type?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class BulkTargetDto {
  @IsOptional() @IsArray() @ArrayMaxSize(250) @IsMongoId({ each: true }) productIds?: string[];
  @IsOptional() @IsBoolean() selectAll?: boolean;
  @IsOptional() @ValidateNested() @Type(() => BulkFilterDto) filter?: BulkFilterDto;
}

export class BulkStatusDto extends BulkTargetDto {
  /** Shopify: Active / Draft / Archived (Archived = Solvexo's 'inactive'). */
  @IsIn(['active', 'draft', 'inactive']) status: 'active' | 'draft' | 'inactive';
}

export class BulkTagsDto extends BulkTargetDto {
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) add?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) remove?: string[];
}

export class BulkVariantEditDto {
  @IsMongoId() variantId: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100_000_000) price?: number;
  /** null clears the compare-at price. */
  @IsOptional() @IsNumber() @Min(0) @Max(100_000_000) compareAtPrice?: number | null;
  @IsOptional() @IsString() @MaxLength(64) sku?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000) stock?: number;
}

export class BulkProductEditDto {
  @IsMongoId() productId: string;
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsIn(['active', 'draft', 'inactive']) status?: 'active' | 'draft' | 'inactive';
  @IsOptional() @IsArray() @ArrayMaxSize(250) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => BulkVariantEditDto) variants?: BulkVariantEditDto[];
}

export class BulkEditDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => BulkProductEditDto)
  updates: BulkProductEditDto[];
}
