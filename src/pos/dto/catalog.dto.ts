/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsMongoId, IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { STOCK_ADJUSTMENT_REASONS } from '../../inventory/schemas/stock-adjustment.schema';

/** G2.6 POS catalog edit — price, barcode, PCT/HS code and category. A manager's PIN session is required; every change is audited with before/after. */
export class UpdateCatalogVariantDto {
  @ApiProperty({ required: false, example: 12.5, description: 'New price in the store currency; must be representable in its minor units (PKR 2 decimals, JPY 0, KWD 3)' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) price?: number;

  @ApiProperty({ required: false, nullable: true, description: 'Barcode (unique per store); null clears it' })
  @IsOptional() @IsString() @MaxLength(64) barcode?: string | null;

  @ApiProperty({ required: false, nullable: true, example: '09024090', description: 'PCT / HS code (6–10 digits, dots allowed); null clears it' })
  @IsOptional() @IsString() @Matches(/^(\d{6,10}|\d[\d.]{4,12}\d)?$/, { message: 'hsCode must be 6 to 10 digits (dots allowed)' }) hsCode?: string | null;

  @ApiProperty({ required: false, description: 'Category of the PRODUCT this variant belongs to' })
  @IsOptional() @IsMongoId() categoryId?: string;

  @ApiProperty({ required: false, description: 'Why (shown in the audit log)' })
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

/** Stock changes always go through a stock movement (never an overwrite): a signed delta + a reason. */
export class AdjustCatalogStockDto {
  @ApiProperty({ example: -2, description: 'Units to add (positive) or remove (negative); never 0' })
  @Type(() => Number) @IsInt() delta: number;

  @ApiProperty({ enum: STOCK_ADJUSTMENT_REASONS as unknown as string[] })
  @IsIn(STOCK_ADJUSTMENT_REASONS as unknown as string[]) reason: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
